#!/usr/bin/env python3
"""Post new news sweeps to one Discord channel.

Each run posts the visible feed cards of every finished sweep newer than the last
one posted, oldest sweep first, and records each sweep's ID in
state_dir/last-sweep.json once its messages are sent. The first run only records
the latest sweep, so existing history is not posted. If the process dies after
posting a sweep but before saving its ID, the next run posts that sweep again.

Standard library only. `run` writes its JSON result to stderr and nothing to
stdout, so a script-only scheduler has nothing to forward as a second message.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_UNITS = 1800  # Discord allows 2000 characters per message; leave headroom.
MAX_BODY = 4 * 1024 * 1024
MAX_PAGES = 50
PAGE_SIZE = 100
PENDING = {"queued", "running"}  # Every other sweep status is final.
NO_MENTIONS = {"parse": []}
DISCORD_API = "https://discord.com/api/v10"
CONFIG_KEYS = {"base_url", "token_file", "state_dir", "target", "timezone", "news_url"}
# The card props shown under each card's title, by card component.
EXCERPT = {
    "headline": ("dek",),
    "brief": ("summary",),
    "signal_alert": ("why",),
    "fact_check": ("verdict", "evidence"),
    "hype_watch": ("reality_check",),
    "release": ("changes",),
    "thread_pulse": ("takes",),
    "quote": ("quote", "speaker"),
}


class PublisherError(Exception):
    pass


class HttpStatus(PublisherError):
    def __init__(self, url, code, retry_after=None):
        super().__init__(f"{urlsplit(url).hostname} returned HTTP {code}")
        self.code, self.retry_after = code, retry_after


def require(condition, message):
    if not condition:
        raise PublisherError(message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # urllib raises the 3xx as an HTTPError instead of following it.


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def http_json(request, timeout=15):
    try:
        with OPENER.open(request, timeout=timeout) as response:
            body = response.read(MAX_BODY + 1)
    except HTTPError as error:
        retry_after = error.headers.get("Retry-After")
        error.close()
        raise HttpStatus(request.full_url, error.code, retry_after) from None
    except OSError:
        raise PublisherError(f"{urlsplit(request.full_url).hostname} is unreachable") from None
    require(len(body) <= MAX_BODY, "response too large")
    try:
        return json.loads(body)
    except ValueError:
        raise PublisherError("response is not JSON") from None


# ------------------------------------------------------------------ configuration and secrets


def load_config(config_path):
    """Read client settings; token_file and state_dir resolve relative to the JSON file."""
    path = Path(config_path).resolve()
    config = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(config, dict), "config must be a JSON object")
    require(set(config) <= CONFIG_KEYS, f"unknown config keys: {sorted(set(config) - CONFIG_KEYS)}")
    missing = CONFIG_KEYS - {"timezone"} - set(config)
    require(not missing, f"missing config keys: {sorted(missing)}")
    for key in ("base_url", "news_url"):
        parts = urlsplit(config[key])
        require(parts.scheme in ("http", "https") and bool(parts.hostname)
                and not parts.username and not parts.password, f"{key} must be an http(s) URL")
    base = urlsplit(config["base_url"])
    require(base.path in ("", "/") and not base.query and not base.fragment,
            "base_url must be an origin, without a path")
    config["base_url"] = config["base_url"].rstrip("/")
    require(re.fullmatch(r"discord:[0-9]{17,20}", str(config["target"])) is not None,
            "target must be discord:<channel ID>")
    config.setdefault("timezone", "Asia/Taipei")
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        ZoneInfo(config["timezone"])
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise PublisherError("unknown timezone") from None
    for key in ("token_file", "state_dir"):
        config[key] = str(path.parent / config[key])  # An absolute value replaces the parent.
    return config


def read_token_file(path):
    with open(path, encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0,
                "token_file must be a private regular file (chmod 600)")
        token = handle.read(4097).strip()
    require(0 < len(token) <= 4096 and not any(c.isspace() for c in token), "invalid token in token_file")
    return token


def bot_token():
    """DISCORD_BOT_TOKEN from the active Hermes profile, or the environment when Hermes is absent."""
    try:
        from agent.secret_scope import build_profile_secret_scope
        from hermes_constants import get_hermes_home
    except ModuleNotFoundError as error:
        # Fall back only when Hermes itself is missing, never when it is installed but broken.
        if error.name not in {"agent", "agent.secret_scope", "hermes_constants"}:
            raise
        token = os.environ.get("DISCORD_BOT_TOKEN", "")
    else:
        token = build_profile_secret_scope(get_hermes_home()).get("DISCORD_BOT_TOKEN", "")
    require(isinstance(token, str) and 0 < len(token) <= 4096 and not any(c.isspace() for c in token),
            "no valid DISCORD_BOT_TOKEN available")
    return token


# ------------------------------------------------------------------ news API and Discord


class News:
    """GET-only client for the scoped news API (the Hermes bridge or the API itself)."""

    def __init__(self, base_url, token):
        self.base, self.token = base_url, token

    def get(self, path, **params):
        url = self.base + path + ("?" + urlencode(params) if params else "")
        return http_json(Request(url, headers={"Authorization": "Bearer " + self.token,
                                               "Accept": "application/json"}))

    def latest_finished_sweep_id(self):
        """The newest sweep that is not queued or running, so a sweep in progress is posted later."""
        page = self.get("/v1/sweeps", limit=PAGE_SIZE)
        require(isinstance(page, list), "unexpected /v1/sweeps response")
        pending = [sweep["id"] for sweep in page if sweep.get("status") in PENDING]
        finished = [sweep["id"] for sweep in page if sweep["id"] < min(pending, default=float("inf"))]
        return max(finished, default=0)

    def sweeps_after(self, last_id):
        """Every sweep newer than last_id, oldest first. /v1/sweeps pages newest first."""
        found, before = [], None
        for _ in range(MAX_PAGES):
            page = self.get("/v1/sweeps", limit=PAGE_SIZE, **({"before": before} if before else {}))
            require(isinstance(page, list), "unexpected /v1/sweeps response")
            found += [sweep for sweep in page if sweep["id"] > last_id]
            if len(page) < PAGE_SIZE or page[-1]["id"] <= last_id:
                return sorted(found, key=lambda sweep: sweep["id"])
            before = page[-1]["id"]
        raise PublisherError("too many new sweeps to scan")

    def cards_by_sweep(self, sweep_ids):
        """Visible feed cards from these sweeps. Older cards of a story that later developed are
        hidden from the feed, so each story appears once, as its latest card."""
        wanted, oldest = set(sweep_ids), min(sweep_ids)
        cards, before = {}, None
        for _ in range(MAX_PAGES):
            page = self.get("/v1/feed", limit=PAGE_SIZE, **({"before": before} if before else {}))
            items = page.get("items") if isinstance(page, dict) else None
            require(isinstance(items, list), "unexpected /v1/feed response")
            for card in items:
                if card.get("kind") == "news" and card.get("sweepId") in wanted:
                    cards.setdefault(card["sweepId"], []).append(card)
            # Pages run backwards by card ID and sweeps run one at a time, so once a page holds a
            # card from an older sweep, every earlier page is older too.
            older = any(isinstance(c.get("sweepId"), int) and c["sweepId"] < oldest for c in items)
            if older or not page.get("cursor"):
                return cards
            before = int(page["cursor"])
        raise PublisherError("too many feed pages to scan")


class Discord:
    def __init__(self, target, token):
        self.channel, self.token = target.split(":", 1)[1], token

    def post(self, content, nonce):
        body = json.dumps({"content": content, "allowed_mentions": NO_MENTIONS, "nonce": nonce,
                           "enforce_nonce": True, "flags": 4}).encode()  # flags 4: no link embeds
        for attempt in range(3):
            request = Request(f"{DISCORD_API}/channels/{self.channel}/messages", data=body, method="POST",
                              headers={"Authorization": "Bot " + self.token,
                                       "Content-Type": "application/json",
                                       "User-Agent": "pi-durable-news-agent-publisher/2"})
            try:
                return http_json(request)
            except HttpStatus as error:
                # A 429 means Discord rejected the message, so retrying cannot post it twice.
                if error.code != 429 or attempt == 2:
                    raise
                time.sleep(min(float(error.retry_after or 1), 30))


# ------------------------------------------------------------------ rendering


def safe_text(value):
    """Plain text for Discord: no control characters, mentions or markdown."""
    text = "".join(c for c in str(value) if c in "\n\t" or not unicodedata.category(c).startswith("C"))
    text = text.replace("@", "＠").replace("\t", " ")
    return re.sub(r"([\\`*_{}\[\]()<>|#~])", r"\\\1", text)


def flatten(value, depth=0):
    if isinstance(value, list) and depth < 4:
        return "\n".join("• " + flatten(v, depth + 1) for v in value)
    if isinstance(value, dict) and depth < 4:
        return "\n".join(f"{safe_text(k)}: {flatten(v, depth + 1)}" for k, v in value.items() if v is not None)
    return safe_text(value)


def units(text):
    return len(text.encode("utf-16-le")) // 2  # Discord counts UTF-16 code units.


def local_time(value, pattern, timezone):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    try:
        return datetime.fromisoformat(value).astimezone(ZoneInfo(timezone)).strftime(pattern)
    except (TypeError, ValueError, OverflowError):
        return None


def scores(card):
    hfs = card.get("hfs") or {}
    values = {key: hfs.get(key) for key in ("facts", "signal", "hype")}
    return values if all(isinstance(v, (int, float)) for v in values.values()) else None


def render_card(card, timezone):
    props = card.get("props") or {}
    title = card.get("title") or "Untitled"
    if card.get("component") == "release" and props.get("version"):
        title = f"{title} {props['version']}"
    source = card.get("sourceName") or "Unknown source"
    lines = [f"{safe_text(source)}: **{safe_text(title).replace(chr(10), ' ')}**"]
    published = local_time(card.get("publishedAt"), "%Y-%m-%d %H:%M", timezone)
    collected = local_time(card.get("createdAt"), "%Y-%m-%d %H:%M", timezone)
    lines.append(published or (f"{collected} (collected)" if collected else "Published time unavailable"))
    hfs = scores(card)
    if hfs:
        top = max(("facts", "signal", "hype"), key=lambda key: hfs[key]).title()
        lines.append(f"*{top}* - `F: {hfs['facts']:g}%; S: {hfs['signal']:g}%; H: {hfs['hype']:g}%`")
    excerpt = [flatten(props[key]) for key in EXCERPT.get(card.get("component"), ())
               if props.get(key) not in (None, "", [], {})]
    if excerpt:
        lines.append((" — " if card.get("component") == "quote" else "\n").join(excerpt))
    return "\n".join(lines)


def split_units(text, budget):
    """Cut text to fit budget, preferring a line or word break in the second half."""
    used = 0
    for index, char in enumerate(text):
        used += units(char)
        if used > budget:
            head = text[:index]
            cut = max(head.rfind("\n"), head.rfind(" "))
            if cut > len(head) // 2:
                return head[:cut], text[cut + 1:]
            return head, text[index:]
    return text, ""


def pack(blocks, limit=MAX_UNITS):
    """Join blocks into messages under limit, keeping each block whole when it fits in one."""
    messages, buffer = [], ""
    for block in blocks:
        while block:
            joined = buffer + "\n\n" + block if buffer else block
            if units(joined) <= limit:
                buffer, block = joined, ""
            elif buffer:
                messages.append(buffer)
                buffer = ""
            else:
                head, block = split_units(block, limit)
                messages.append(head)
    return messages + ([buffer] if buffer else [])


def render_sweep(sweep, cards, config):
    """The messages for one sweep: a dated header with the UI link, then its cards by Facts, Signal."""
    if not cards:
        return []
    ordered = sorted(cards, key=lambda c: (-(scores(c) or {}).get("facts", 0),
                                           -(scores(c) or {}).get("signal", 0), c["id"]))
    date = local_time(sweep.get("endedAt") or sweep.get("createdAt"), "%Y-%m-%d", config["timezone"])
    link = config["news_url"].replace("(", "%28").replace(")", "%29")
    header = f"{date or 'Latest'} News:\n*{len(cards)} news* - [Open in News]({link})\n\n---"
    return pack([header] + [render_card(card, config["timezone"]) for card in ordered])


# ------------------------------------------------------------------ state and runs


class State:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(self.dir.stat().st_mode & 0o077 == 0, "state_dir must be private (chmod 700)")
        self.file = self.dir / "last-sweep.json"

    def load(self):
        try:
            return int(json.loads(self.file.read_text())["last_sweep_id"])
        except FileNotFoundError:
            return None

    def save(self, sweep_id):
        temporary = self.file.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump({"last_sweep_id": sweep_id}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.file)

    @contextlib.contextmanager
    def lock(self):
        """Yield True while holding the run lock, or False when another run holds it."""
        with open(self.dir / "publisher.lock", "a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            yield True


def ready_sweeps(news, last_id):
    """New sweeps up to, not including, the first one still queued or running."""
    ready = []
    for sweep in news.sweeps_after(last_id):
        if sweep.get("status") in PENDING:
            break
        ready.append(sweep)
    return ready


def nonce(config, sweep_id, index):
    return hashlib.sha256(f"{config['target']}:{sweep_id}:{index}".encode()).hexdigest()[:25]


def run(config, news, post, state):
    last = state.load()
    if last is None:
        latest = news.latest_finished_sweep_id()
        state.save(latest)
        return {"status": "initialized", "last_sweep_id": latest}
    sweeps = ready_sweeps(news, last)
    if not sweeps:
        return {"status": "idle", "last_sweep_id": last}
    cards = news.cards_by_sweep([sweep["id"] for sweep in sweeps])
    messages = 0
    for sweep in sweeps:
        for index, content in enumerate(render_sweep(sweep, cards.get(sweep["id"], []), config)):
            post(content, nonce(config, sweep["id"], index))
            messages += 1
        state.save(sweep["id"])
    return {"status": "posted", "sweeps": len(sweeps), "messages": messages, "last_sweep_id": sweeps[-1]["id"]}


def preview(config, news, state):
    """What the next run would post. Changes nothing."""
    last = state.load()
    if last is None:
        return {"status": "uninitialized", "note": "the first run records the latest sweep and posts nothing"}
    sweeps = ready_sweeps(news, last)
    cards = news.cards_by_sweep([s["id"] for s in sweeps]) if sweeps else {}
    return {"status": "preview", "last_sweep_id": last, "sweeps": [
        {"sweep_id": s["id"], "messages": render_sweep(s, cards.get(s["id"], []), config)} for s in sweeps]}


def main(argv=None, news=None, discord=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, help="path to client.json")
    parser.add_argument("command", nargs="?", default="run", choices=["run", "preview"])
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        state = State(config["state_dir"])
        news = news or News(config["base_url"], read_token_file(config["token_file"]))
        with state.lock() as locked:
            if not locked:
                print(json.dumps({"status": "busy"}), file=sys.stderr)
                return 0
            if args.command == "preview":
                print(json.dumps(preview(config, news, state), ensure_ascii=False, indent=2))
                return 0
            discord = discord or Discord(config["target"], bot_token())
            result = run(config, news, discord.post, state)
        print(json.dumps(result), file=sys.stderr)
        return 0
    except Exception as error:  # Never print request objects, tokens or tracebacks.
        message = str(error) if isinstance(error, PublisherError) else "unexpected error"
        print(json.dumps({"status": "error", "category": type(error).__name__, "message": message}),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
