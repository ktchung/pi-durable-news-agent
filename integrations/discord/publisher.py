#!/usr/bin/env python3
"""Deterministic, GET-only news collector and receipt-gated Discord outbox.

No Discord sender, model calls, sweep initiation, or Hermes state access. `tick`
is intentionally silent: it prepares an outbox, NEVER emits deliverable stdout.
A trusted integration must claim once, send, read back every exact message, ack.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_UNITS = 1800
MAX_MESSAGES = 200
MAX_PAGES = 1000
MAX_RECORDS = 100000
MAX_BODY = 4 * 1024 * 1024
FIELDS = {
    "headline": ("title", "dek"),
    "brief": ("title", "summary"),
    "signal_alert": ("title", "action", "why"),
    "fact_check": ("claim", "verdict", "evidence"),
    "hype_watch": ("title", "reality_check"),
    "release": ("name", "version", "changes"),
    "thread_pulse": ("title", "takes"),
    "quote": ("quote", "speaker"),
}


class PublisherError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PublisherError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ident(value):
    require(type(value) is int and value > 0, "invalid positive integer identifier")
    return value


def units(text):
    return len(text.encode("utf-16-le")) // 2


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # urllib raises HTTPError; get() closes it without following.


class GetClient:
    """Small standalone adapter; parent may inject any client with get(path, params).

    Reads only the configured bridge token, never environment credentials. No
    redirects or environment proxy, and only fixed read endpoint patterns exist.
    """
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve()
        config = load_config(self.config_path)
        self.config = config
        base = config.get("base_url", "")
        parts = urlsplit(base)
        require(parts.scheme in ("http", "https") and bool(parts.hostname)
                and not parts.username and not parts.password and not parts.query
                and not parts.fragment and parts.path in ("", "/"), "invalid bridge base_url")
        self.base = base.rstrip("/")
        token_path = Path(config["token_file"])
        with token_path.open(encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0,
                    "bridge token must be a private regular file (mode 600 or stricter)")
            token = handle.read(4097).strip()
        require(0 < len(token) <= 4096 and not any(c.isspace() for c in token), "invalid bridge token")
        self._token = token
        self._opener = build_opener(ProxyHandler({}), NoRedirect())

    def get(self, path, params=None):
        require(path in ("/v1/sweeps", "/v1/feed") or
                re.fullmatch(r"/v1/(?:cards|sweeps)/[1-9][0-9]*", path), "GET endpoint not allowlisted")
        params = params or {}
        require(set(params) <= {"limit", "before"}, "unexpected GET query parameter")
        for key, value in params.items():
            require(type(value) is int and value > 0, "invalid GET query value")
        url = self.base + path + (("?" + urlencode(params)) if params else "")
        request = Request(url, headers={"Authorization": "Bearer " + self._token,
                                       "Accept": "application/json"}, method="GET")
        try:
            with self._opener.open(request, timeout=10) as response:
                require(response.status == 200, "unexpected API response status")
                data = response.read(MAX_BODY + 1)
                require(len(data) <= MAX_BODY, "API response size limit exceeded")
            return json.loads(data.decode("utf-8"))
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise PublisherError(f"API HTTP {code}; nothing acknowledged") from None
        except (URLError, TimeoutError, UnicodeError, ValueError, OSError):
            raise PublisherError("API request/JSON failure; nothing acknowledged") from None


def safe_text(value):
    require(isinstance(value, str), "expected text")
    require(len(value) <= 32000, "card text exceeds finite output budget")
    value = "".join(c for c in value if c in "\n\t" or not unicodedata.category(c).startswith("C"))
    value = value.replace("@", "＠").replace("\r", "").replace("\t", " ")
    return re.sub(r"([\\`*_{}\[\]()<>|#~])", r"\\\1", value)


def flatten(value, depth=0):
    require(depth < 5, "card props nesting exceeds limit")
    if isinstance(value, str):
        return safe_text(value)
    if type(value) in (int, float):
        return safe_text(canonical(value))
    if isinstance(value, list):
        require(0 < len(value) <= 100, "invalid card props list size")
        return "\n".join("• " + flatten(v, depth + 1) for v in value)
    if isinstance(value, dict):
        require(0 < len(value) <= 100, "invalid card props object size")
        return "\n".join(safe_text(str(k)) + ": " + flatten(v, depth + 1)
                         for k, v in value.items() if v is not None)
    raise PublisherError("unsupported card props value")


def safe_url(value):
    require(isinstance(value, str) and 0 < len(value) <= 1600, "missing or oversized source URL")
    require(not any(c.isspace() or unicodedata.category(c).startswith("C") for c in value),
            "unsafe source URL whitespace/control")
    try:
        parsed = urlsplit(value)
        require(parsed.scheme.lower() in ("https", "http") and bool(parsed.hostname)
                and not parsed.username and not parsed.password, "unsafe source URL scheme/authority")
        parsed.port  # malformed ports must fail closed
        host = parsed.hostname.encode("idna").decode("ascii")
        require(bool(re.fullmatch(r"[A-Za-z0-9.:-]+", host)), "unsafe source URL host")
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port is not None:
            host += ":" + str(parsed.port)
        path = quote(parsed.path, safe="/%:!$&'()*+,;=-._~")
        query = quote(parsed.query, safe="%/:?&=+$,;!-._~")
        fragment = quote(parsed.fragment, safe="%/:?&=+$,;!-._~")
        return urlunsplit((parsed.scheme.lower(), host, path, query, fragment))
    except (ValueError, UnicodeError):
        raise PublisherError("malformed source URL") from None


def validate_target(target):
    require(isinstance(target, str) and re.fullmatch(r"discord:[0-9]{17,20}", target),
            "target must be discord:<17-20 digit channel ID>")
    return target


def validate_timezone(timezone):
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    require(isinstance(timezone, str) and bool(timezone), "missing timezone")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise PublisherError("unknown timezone; install system IANA timezone data") from None
    return timezone


def load_config(config_path):
    """Load settings only; relative paths are anchored to this JSON file."""
    path = Path(config_path).resolve()
    config = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(config, dict), "client config must be an object")
    require(set(config) <= {"base_url", "token_file", "state_dir", "target", "timezone", "news_url"},
            "unknown client configuration field")
    config["target"] = validate_target(config.get("target"))
    config["timezone"] = validate_timezone(config.get("timezone", "Asia/Taipei"))
    config["news_url"] = safe_url(config.get("news_url")).replace("(", "%28").replace(")", "%29")
    base = config.get("base_url")
    require(isinstance(base, str), "missing bridge base_url")
    safe_url(base)
    parts = urlsplit(base)
    require(parts.path in ("", "/") and not parts.query and not parts.fragment,
            "bridge base_url must be an origin")
    for key in ("token_file", "state_dir"):
        value = config.get(key)
        require(isinstance(value, str) and bool(value), f"missing {key}")
        candidate = Path(value)
        config[key] = str(candidate if candidate.is_absolute() else path.parent / candidate)
    return config


def configured_publisher(config, client=None):
    return Publisher(client, config["state_dir"], target=config["target"],
                     news_url=config["news_url"], timezone=config["timezone"])


def hfs_scores(card):
    hfs = card.get("hfs")
    require(isinstance(hfs, dict), "card has no HFS scores")
    scores = {key: hfs.get(key) for key in ("facts", "signal", "hype")}
    require(all(type(value) in (int, float) and 0 <= value <= 100 for value in scores.values()),
            "invalid HFS score; expected a number from 0 to 100")
    return scores


def local_time(value, pattern, timezone="Asia/Taipei"):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    require(isinstance(value, str) and bool(value), "missing news timestamp")
    try:
        parsed = datetime.fromisoformat(value)
        require(parsed.tzinfo is not None, "news timestamp must include timezone")
        return parsed.astimezone(ZoneInfo(timezone)).strftime(pattern)
    except (ValueError, OverflowError):
        raise PublisherError("invalid news timestamp") from None


def render_card(card, detail, timezone="Asia/Taipei"):
    require(card.get("kind") == "news", "non-news card cannot be published")
    component, props = card.get("component"), card.get("props")
    require(component in FIELDS and isinstance(props, dict), "unsupported card component/props")
    for key in FIELDS[component]:
        require(key in props and bool(flatten(props[key]).strip()),
                f"missing or empty required {component} property: {key}")
    item, sources = detail.get("item") or {}, card.get("sources") or []
    require(isinstance(item, dict) and isinstance(sources, list) and len(sources) <= 100,
            "invalid card item/sources")
    # Source URLs stay validated and available in the service, but are not
    # repeated in Discord. The batch header has the single requested UI link.
    safe_url(card.get("url") or item.get("url"))
    for source in sources:
        require(isinstance(source, dict), "invalid source record")
        safe_url(source.get("url"))
    if card.get("discussionUrl"):
        safe_url(card["discussionUrl"])
    source_name = card.get("sourceName") or item.get("sourceName") or "Unknown source"
    title = props.get("title") or card.get("title") or props.get("claim") or props.get("quote")
    if component == "release":
        require(isinstance(props["changes"], list), "release changes must be a list")
        title = props["name"] + " " + props["version"]
        excerpt = " ".join(flatten(value) for value in props["changes"])
    elif component == "headline":
        excerpt = flatten(props["dek"])
    elif component == "brief":
        excerpt = flatten(props["summary"])
    elif component == "signal_alert":
        excerpt = flatten(props["why"])
    elif component == "fact_check":
        excerpt = flatten(props["verdict"]) + "\n" + flatten(props["evidence"])
    elif component == "hype_watch":
        excerpt = flatten(props["reality_check"])
    elif component == "thread_pulse":
        excerpt = flatten(props["takes"])
    else:
        excerpt = flatten(props["quote"]) + " — " + flatten(props["speaker"])
    require(isinstance(source_name, str) and isinstance(title, str) and bool(title.strip()),
            "missing card source/title")
    published = card.get("publishedAt") or item.get("publishedAt")
    collected = not published
    timestamp = published or card.get("createdAt")
    stamp = (local_time(timestamp, "%Y-%m-%d %H:%M", timezone) + (" (collected)" if collected else "")
             if timestamp else "Published time unavailable")
    scores = hfs_scores(card)
    category = max(("facts", "signal", "hype"), key=lambda key: scores[key]).title()
    lines = [safe_text(source_name.replace("\n", " ")) + ": **" + safe_text(title.replace("\n", " ")) + "**",
             stamp,
             f"*{category}* - `F: {scores['facts']:g}%; S: {scores['signal']:g}%; H: {scores['hype']:g}%`",
             excerpt]
    require(all(units(line) <= MAX_UNITS for line in lines[:3]), "card metadata exceeds message budget")
    return lines


def cut_units(text, budget):
    used = 0
    for index, char in enumerate(text):
        size = units(char)
        if used + size > budget:
            return text[:index], text[index:]
        used += size
    return text, ""


def render_groups(groups, news_url, timezone="Asia/Taipei"):
    messages, card_ids = [], []
    for sweep, records in groups:
        if not records:
            continue
        date = local_time(sweep.get("endedAt") or sweep.get("createdAt"), "%Y-%m-%d", timezone)
        buffer = f"{date} News:\n*{len(records)} news* - [Open in News]({news_url})\n\n---"
        require(units(buffer) <= MAX_UNITS, "sweep header exceeds message budget")

        def flush():
            nonlocal buffer
            if buffer.strip():
                content = buffer.rstrip("\n")
                messages.append({"content": content, "content_sha256": digest(content),
                                 "allowed_mentions": {"parse": [], "users": [], "roles": [],
                                                      "replied_user": False}})
                require(len(messages) <= MAX_MESSAGES, "message budget exceeded; no cards were acknowledged")
            buffer = ""  # Header/UI link appears only once per sweep, not per chunk.

        ordered = sorted(records, key=lambda pair: (-hfs_scores(pair[0])["facts"],
                                                    -hfs_scores(pair[0])["signal"], pair[0]["id"]))
        for card, detail in ordered:
            card_ids.append(ident(card["id"]))
            block = "\n".join(render_card(card, detail, timezone))
            separator = "\n\n" if buffer else ""
            if units(buffer + separator + block) <= MAX_UNITS:
                buffer += separator + block
                continue
            if units(block) <= MAX_UNITS:
                flush()  # Keep an ordinary card whole on the next message.
                buffer = block
                continue
            # Oversized excerpts are split without truncation. Metadata lines
            # are bounded above; a UTF-16-aware cut never splits a code point.
            for line in block.split("\n"):
                while line:
                    separator = "\n" if buffer else ""
                    budget = MAX_UNITS - units(buffer) - len(separator)
                    if budget < 2:
                        flush()
                        continue
                    if units(line) <= MAX_UNITS and units(line) > budget:
                        flush()
                        continue
                    prefix, line = cut_units(line, budget)
                    buffer += separator + prefix
                    if line:
                        flush()
        flush()
    require(len(card_ids) == len(set(card_ids)), "duplicate rendered card IDs")
    require(all(units(message["content"]) <= MAX_UNITS for message in messages), "message size verification failed")
    return messages, card_ids


class Publisher:
    def __init__(self, client, state_dir, *, target, news_url, timezone="Asia/Taipei", page_size=100):
        require(type(page_size) is int and 1 <= page_size <= 200, "page_size must be 1..200")
        self.target = validate_target(target)
        self.news_url = safe_url(news_url).replace("(", "%28").replace(")", "%29")
        self.timezone = validate_timezone(timezone)
        self.client, self.page_size = client, page_size
        state_dir = Path(state_dir)
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(state_dir.is_dir() and state_dir.stat().st_mode & 0o077 == 0,
                "publisher state directory must be private (mode 700)")
        db_path = state_dir / "publisher.sqlite3"
        fd = os.open(db_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        require(db_path.stat().st_mode & 0o077 == 0, "publisher database must be private")
        self.db = sqlite3.connect(db_path, timeout=5, isolation_level=None)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox(
                id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL,
                claim_token TEXT, receipt TEXT, failure TEXT);
            CREATE TABLE IF NOT EXISTS delivered(
                card_id INTEGER PRIMARY KEY, outbox_id TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _baseline(self):
        row = self.db.execute("SELECT value FROM meta WHERE key='baseline'").fetchone()
        return json.loads(row[0]) if row else None

    def status(self):
        return {"baseline": self._baseline(), "delivered_cards": self.db.execute(
            "SELECT count(*) FROM delivered").fetchone()[0], "outboxes": [
                {"outbox_id": row[0], "status": row[1]} for row in
                self.db.execute("SELECT id,status FROM outbox ORDER BY rowid")]}

    def _snapshot(self):
        self._deadline = time.monotonic() + 90
        stats = {"sweep_pages": 0, "feed_pages": 0, "sweeps": 0, "cards": 0, "duplicate_records": 0}
        result = []
        for kind, path in (("sweep", "/v1/sweeps"), ("feed", "/v1/feed")):
            records = {}
            before = None
            for page in range(MAX_PAGES):
                require(time.monotonic() < self._deadline, "API scan deadline exceeded")
                params = {"limit": self.page_size}
                if before is not None:
                    params["before"] = before
                data = self._get(path, params)
                rows = data if kind == "sweep" else data.get("items") if isinstance(data, dict) else None
                require(isinstance(rows, list) and len(rows) <= self.page_size, "invalid API page cardinality")
                stats[kind + "_pages"] += 1
                ids = []
                for row in rows:
                    require(isinstance(row, dict), "invalid API record")
                    rid = ident(row.get("id"))
                    if kind == "feed":
                        require(row.get("kind") == "news", "feed contains a non-news card")
                        if row.get("sweepId") is not None:
                            ident(row["sweepId"])
                    require(before is None or rid < before, "pagination did not move strictly backwards")
                    if rid in records:
                        require(records[rid] == row, "conflicting duplicate API record")
                        stats["duplicate_records"] += 1
                    records[rid] = row
                    ids.append(rid)
                require(len(records) <= MAX_RECORDS, "API record budget exceeded")
                cursor = data.get("cursor") if kind == "feed" else None
                if kind == "feed":
                    if cursor is None:
                        require(len(rows) < self.page_size, "full feed page missing cursor")
                        break
                    require(isinstance(cursor, str) and re.fullmatch(r"[1-9][0-9]*", cursor), "invalid feed cursor")
                    require(bool(ids) and int(cursor) == min(ids), "feed cursor/cardinality inconsistency")
                elif len(rows) < self.page_size:
                    break
                require(bool(ids), "empty page with continuation")
                before = min(ids)
            else:
                raise PublisherError("API pagination budget exhausted; scan incomplete")
            result.append(records)
        sweeps, cards = result
        stats.update(sweeps=len(sweeps), cards=len(cards))
        # A card without any known sweep is not publishable; do not invent one.
        return sweeps, cards, stats

    def _get(self, path, params=None):
        require(time.monotonic() < self._deadline, "API collection deadline exceeded")
        result = self.client.get(path, params)
        require(time.monotonic() < self._deadline, "API collection deadline exceeded")
        return result

    @staticmethod
    def eligible(sweep):
        audit = sweep.get("audit")
        return (sweep.get("status") == "completed" and isinstance(audit, dict)
                and audit.get("missing") == [])

    def _card_detail(self, cid, sid, feed_card=None, allow_hidden=False):
        detail = self._get(f"/v1/cards/{cid}")
        require(isinstance(detail, dict) and isinstance(detail.get("card"), dict), "invalid card detail")
        current = detail["card"]
        require(ident(current.get("id")) == cid and current.get("kind") == "news"
                and ident(current.get("sweepId")) == sid, "card detail has foreign ID/kind/sweep membership")
        if feed_card is not None:
            # Image/feedback scores may change; publication inputs may not.
            for key in ("id", "kind", "sweepId", "component", "props", "url", "sources",
                        "discussionUrl", "title", "sourceName", "hfs", "publishedAt", "createdAt"):
                require(current.get(key) == feed_card.get(key),
                        "card changed during collection; retry collection safely")
        require(allow_hidden or not current.get("hiddenFromFeed"), "card hidden during collection")
        return detail

    def _recover_cards(self, sweep, cards, selected):
        """Recover only exact successful audit references, never probe card IDs."""
        sid, expected = sweep["id"], sweep["presented"]
        audit = self._get(f"/v1/sweeps/{sid}")
        require(isinstance(audit, dict), "invalid sweep detail")
        require(ident(audit.get("id")) == sid, "foreign sweep detail")
        for key in ("status", "presented", "audit"):
            require(audit.get(key) == sweep.get(key), "sweep changed during collection")
        calls = audit.get("toolCalls")
        require(isinstance(calls, list) and len(calls) <= MAX_RECORDS, "invalid sweep tool-call audit")
        referenced = set()
        for call in calls:
            require(isinstance(call, dict), "invalid sweep tool-call record")
            if (call.get("toolName") == "present_news" and call.get("status") == "done"
                    and call.get("isError") is False):
                details = call.get("details")
                require(isinstance(details, dict), "invalid successful presentation reference")
                referenced.add(ident(details.get("cardId")))
        require(len(referenced) == expected and {c["id"] for c in selected} <= referenced,
                f"sweep {sid} cardinality mismatch: presented={expected}, "
                f"successful audit references={len(referenced)}; no delivery acknowledged")
        require(len(set(cards) | referenced) <= MAX_RECORDS, "API record budget exceeded")
        recovered = {cid: self._card_detail(cid, sid, cards.get(cid), allow_hidden=True)
                     for cid in sorted(referenced)}
        # Keep the snapshot complete for downstream sweep/card binding, but only
        # after every reference, visible input and recovered membership passed.
        cards.update({cid: detail["card"] for cid, detail in recovered.items()})
        return recovered

    def _groups(self, sweeps, cards, ids, include_details=True):
        groups = []
        for sid in sorted(ids):
            sweep = sweeps[sid]
            require(self.eligible(sweep), f"sweep {sid} is not completed with a clean audit")
            expected = sweep.get("presented")
            require(type(expected) is int and 0 <= expected <= MAX_RECORDS, "invalid presented cardinality")
            selected = sorted((c for c in cards.values() if c.get("sweepId") == sid), key=lambda c: c["id"])
            recovered = {}
            if len(selected) != expected:
                recovered = self._recover_cards(sweep, cards, selected)
                selected = [recovered[cid]["card"] for cid in sorted(recovered)]
            require(len(selected) == expected, f"sweep {sid} final cardinality mismatch")
            records = []
            for card in selected:
                if not include_details:
                    records.append((card, {}))
                    continue
                detail = recovered.get(card["id"])
                if detail is None:
                    detail = self._card_detail(card["id"], sid, card)
                records.append((detail["card"], detail))
            groups.append((sweep, records))
        return groups

    def baseline(self, before_sweep_id=None):
        if before_sweep_id is not None:
            ident(before_sweep_id)
        with self.transaction():
            require(self._baseline() is None, "baseline already exists; refusing to reset history")
            sweeps, cards, stats = self._snapshot()
            ids = sorted(sid for sid, s in sweeps.items() if self.eligible(s)
                         and (before_sweep_id is None or sid < before_sweep_id))
            groups = self._groups(sweeps, cards, ids, include_details=False)
            # Baseline is an explicit historical skip, not a publication. Verify
            # cardinality/membership (fetch details only for hidden recovery),
            # without rendering history against the new-delivery message budget.
            card_ids = [card['id'] for _, records in groups for card, _ in records]
            baseline = {"sweep_ids": ids, "card_ids": card_ids, "scan": stats,
                        "before_sweep_id": before_sweep_id,
                        "delivery_confirmed": False, "reason": "explicit historical skip, not delivery"}
            self.db.execute("INSERT INTO meta VALUES ('baseline',?)", (canonical(baseline),))
            return {"status": "baseline_established", "delivery_confirmed": False,
                    "skipped_sweeps": len(ids), "skipped_cards": len(card_ids), "scan": stats}

    def _payload(self, sweeps, cards, ids, stats):
        groups = self._groups(sweeps, cards, ids)
        messages, card_ids = render_groups(groups, self.news_url, self.timezone)
        return {"target": self.target, "sweep_ids": sorted(ids), "card_ids": card_ids,
                "messages": messages, "scan": stats}

    def preview_latest(self):
        sweeps, cards, stats = self._snapshot()
        ids = [sid for sid, sweep in sweeps.items() if sweep.get("status") == "completed"]
        require(bool(ids), "no completed sweep available for preview")
        payload = self._payload(sweeps, cards, [max(ids)], stats)
        return {"status": "preview_only", "delivery_confirmed": False, **payload}

    def prepare(self):
        with self.transaction():
            baseline = self._baseline()
            if baseline is None:
                return {"status": "needs_baseline", "delivery_confirmed": False}
            unresolved = self.db.execute("SELECT id,status FROM outbox WHERE status!='confirmed' ORDER BY rowid LIMIT 1").fetchone()
            if unresolved:
                return {"status": "blocked", "outbox_id": unresolved[0], "outbox_status": unresolved[1],
                        "reason": "unacknowledged outbox; never automatically resend"}
            sweeps, cards, stats = self._snapshot()
            skipped = set(baseline["sweep_ids"])
            # Completed, acknowledged sweeps are immutable publication units. Do
            # not demand that an old visible feed retain them forever: the API
            # deliberately hides older story/release cards after later sweeps.
            for (encoded,) in self.db.execute("SELECT payload FROM outbox WHERE status='confirmed'"):
                skipped.update(json.loads(encoded)["sweep_ids"])
            delivered = {row[0] for row in self.db.execute("SELECT card_id FROM delivered")}
            ids = [sid for sid, s in sweeps.items() if self.eligible(s) and sid not in skipped]
            payload = self._payload(sweeps, cards, ids, stats)
            require(not delivered.intersection(payload["card_ids"]),
                    "card ID reused across sweeps or partial ledger; reconciliation required")
            if not payload["card_ids"]:
                return {"status": "idle", "delivery_confirmed": False, "scan": stats}
            payload["sweep_ids"] = sorted({cards[cid]["sweepId"] for cid in payload["card_ids"]})
            outbox_id = digest(canonical(payload))
            self.db.execute("INSERT INTO outbox(id,status,payload) VALUES (?,'prepared',?)", (outbox_id, canonical(payload)))
            return {"status": "prepared", "outbox_id": outbox_id, "target": self.target,
                    "sweep_ids": payload["sweep_ids"], "card_ids": payload["card_ids"],
                    "message_count": len(payload["messages"]), "delivery_confirmed": False, "scan": stats}

    def show(self, outbox_id):
        row = self.db.execute("SELECT status,payload FROM outbox WHERE id=?", (outbox_id,)).fetchone()
        require(row is not None, "unknown outbox")
        return {"status": row[0], "outbox_id": outbox_id, "inspection_only": True, **json.loads(row[1])}

    def claim(self, outbox_id):
        with self.transaction():
            row = self.db.execute("SELECT status,payload FROM outbox WHERE id=?", (outbox_id,)).fetchone()
            require(row is not None and row[0] == "prepared", "outbox not claimable; possible prior send, do not retry")
            require(json.loads(row[1])["target"] == self.target,
                    "configured target changed; refusing to claim frozen outbox")
            token = secrets.token_hex(24)
            self.db.execute("UPDATE outbox SET status='claimed',claim_token=? WHERE id=?", (token, outbox_id))
            return {"status": "claimed", "outbox_id": outbox_id, "claim_token": token, **json.loads(row[1])}

    def record_failure(self, outbox_id, claim_token, reason):
        require(isinstance(reason, str) and 0 < len(reason) <= 2000, "invalid failure reason")
        with self.transaction():
            row = self.db.execute("SELECT status,claim_token FROM outbox WHERE id=?", (outbox_id,)).fetchone()
            require(row is not None and row[0] in ("claimed", "unknown") and row[1] == claim_token, "invalid failed-send claim")
            self.db.execute("UPDATE outbox SET status='unknown',failure=? WHERE id=?", (reason, outbox_id))
            return {"status": "unknown", "outbox_id": outbox_id, "delivery_confirmed": False}

    def ack(self, receipt):
        require(isinstance(receipt, dict), "receipt must be an object")
        with self.transaction():
            oid = receipt.get("outbox_id")
            row = self.db.execute("SELECT status,payload,claim_token,receipt FROM outbox WHERE id=?", (oid,)).fetchone()
            require(row is not None and row[0] in ("claimed", "unknown", "confirmed"), "outbox must be claimed before ack")
            require(receipt.get("claim_token") == row[2], "receipt claim token mismatch")
            payload = json.loads(row[1])
            require(receipt.get("target") == payload["target"] == self.target and receipt.get("status") == "delivered"
                    and receipt.get("verified") is True and receipt.get("verification") == "discord-readback",
                    "ack requires confirmed exact-target Discord readback, not script/cron success")
            messages = receipt.get("messages")
            require(isinstance(messages, list) and len(messages) == len(payload["messages"]), "incomplete delivery receipt")
            seen = set()
            for n, (evidence, message) in enumerate(zip(messages, payload["messages"])):
                require(isinstance(evidence, dict) and type(evidence.get("index")) is int and evidence["index"] == n,
                        "receipt message index mismatch")
                mid = evidence.get("message_id")
                require(isinstance(mid, str) and re.fullmatch(r"[0-9]{17,20}", mid) and mid not in seen,
                        "missing/duplicate Discord message ID")
                seen.add(mid)
                require(evidence.get("content_sha256") == message["content_sha256"]
                        and evidence.get("readback_content_sha256") == message["content_sha256"],
                        "receipt content/readback hash mismatch")
            encoded = canonical(receipt)
            if row[0] == "confirmed":
                require(row[3] == encoded, "conflicting replayed receipt")
            else:
                for cid in payload["card_ids"]:
                    self.db.execute("INSERT INTO delivered VALUES (?,?)", (cid, oid))
                self.db.execute("UPDATE outbox SET status='confirmed',receipt=? WHERE id=?", (encoded, oid))
            return {"status": "confirmed", "outbox_id": oid, "delivered_cards": len(payload["card_ids"])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Path to client settings JSON")
    sub = parser.add_subparsers(dest="command")
    for command in ("tick", "prepare", "status", "preview-latest"):
        sub.add_parser(command)
    sub.add_parser("baseline").add_argument("--before-sweep-id", type=int,
                                          help="Skip only completed sweeps older than this ID")
    for command in ("claim", "show"):
        sub.add_parser(command).add_argument("outbox_id")
    for command in ("ack", "failure"):
        sub.add_parser(command).add_argument("receipt_file", help="JSON file, or '-' for stdin")
    args = parser.parse_args(argv)
    command = args.command or "tick"
    publisher = None
    try:
        config = load_config(args.config)
        client = GetClient(args.config) if command in ("tick", "prepare", "baseline", "preview-latest") else None
        publisher = configured_publisher(config, client)
        if command == "tick":
            result = publisher.prepare()
        elif command == "baseline":
            result = publisher.baseline(args.before_sweep_id)
        elif command == "preview-latest":
            result = publisher.preview_latest()
        elif command in ("show", "claim"):
            result = getattr(publisher, command)(args.outbox_id)
        elif command in ("ack", "failure"):
            data = json.load(sys.stdin) if args.receipt_file == "-" else json.loads(Path(args.receipt_file).read_text())
            result = publisher.ack(data) if command == "ack" else publisher.record_failure(
                data["outbox_id"], data["claim_token"], data["reason"])
        else:
            result = getattr(publisher, command)()
        print(canonical(result), file=sys.stderr if command == "tick" else sys.stdout)
        return 0
    except (PublisherError, OSError, ValueError, KeyError, TypeError, sqlite3.Error) as exc:
        # Avoid leaking transport credentials or external content in scheduler alerts.
        print(canonical({"status": "error", "error": str(exc) if isinstance(exc, PublisherError)
                         else type(exc).__name__, "delivery_confirmed": False}), file=sys.stderr)
        return 1
    finally:
        if publisher is not None:
            publisher.close()


if __name__ == "__main__":
    raise SystemExit(main())
