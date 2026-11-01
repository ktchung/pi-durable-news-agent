"""Offline tests: an in-memory news API, a recording Discord double, temporary state."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publisher", ROOT / "publisher.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

CHANNEL = "100000000000000001"


def card(cid, sweep, facts=50, signal=40, hype=10, **extra):
    return {"id": cid, "kind": "news", "component": "headline", "sweepId": sweep,
            "title": f"Story {cid}", "props": {"title": f"Story {cid}", "dek": f"Dek {cid}"},
            "sourceName": "Example Wire", "publishedAt": "2026-10-30T01:00:00Z",
            "createdAt": "2026-10-30T02:00:00Z",
            "hfs": {"facts": facts, "signal": signal, "hype": hype}, **extra}


def sweep(sid, status="completed"):
    return {"id": sid, "status": status, "createdAt": "2026-10-30T00:00:00Z",
            "endedAt": "2026-10-30T02:00:00Z"}


class FakeNews(p.News):
    """Pages like the real API: sweeps newest first; feed oldest to newest, cursor on full pages."""

    def __init__(self, sweeps=(), cards=()):
        super().__init__("http://news.invalid", "synthetic-read-token")
        self.sweeps, self.cards, self.calls = list(sweeps), list(cards), []

    def get(self, path, **params):
        self.calls.append((path, params))
        limit, before = params["limit"], params.get("before")
        if path == "/v1/sweeps":
            rows = sorted((s for s in self.sweeps if before is None or s["id"] < before),
                          key=lambda s: -s["id"])
            return rows[:limit]
        rows = sorted(c for c in (c["id"] for c in self.cards) if before is None or c < before)[-limit:]
        items = [next(c for c in self.cards if c["id"] == cid) for cid in rows]
        return {"items": items, "cursor": str(items[0]["id"]) if len(items) == limit else None}


class Posts:
    def __init__(self, fail_at=None):
        self.messages, self.fail_at = [], fail_at

    def __call__(self, content, nonce):
        if self.fail_at is not None and len(self.messages) == self.fail_at:
            raise p.PublisherError("synthetic Discord failure")
        self.messages.append(content)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = p.State(Path(self.tmp.name) / "state")
        self.config = {"target": "discord:" + CHANNEL, "timezone": "Asia/Taipei",
                       "news_url": "https://news.example.test/"}


class RunTests(Base):
    def test_first_run_records_the_latest_finished_sweep_and_posts_nothing(self):
        news = FakeNews([sweep(1), sweep(2), sweep(3, "running")], [card(10, 1), card(11, 2)])
        posts = Posts()
        self.assertEqual(p.run(self.config, news, posts, self.state)["status"], "initialized")
        self.assertEqual(posts.messages, [])
        self.assertEqual(self.state.load(), 2)  # Sweep 3 is still running, so it posts later.

    def test_posts_new_sweeps_oldest_first_then_saves_the_last_one(self):
        self.state.save(1)
        news = FakeNews([sweep(1), sweep(2), sweep(3)],
                        [card(10, 1), card(20, 2), card(30, 3), card(31, None)])
        posts = Posts()
        result = p.run(self.config, news, posts, self.state)
        self.assertEqual(result, {"status": "posted", "sweeps": 2, "messages": 2, "last_sweep_id": 3})
        self.assertIn("Story 20", posts.messages[0])
        self.assertIn("Story 30", posts.messages[1])
        self.assertNotIn("Story 10", "".join(posts.messages))  # Already posted sweep.
        self.assertNotIn("Story 31", "".join(posts.messages))  # Chat card, no sweep.
        self.assertEqual(self.state.load(), 3)
        self.assertEqual(p.run(self.config, news, posts, self.state)["status"], "idle")
        self.assertEqual(len(posts.messages), 2)

    def test_waits_at_a_running_sweep_and_posts_it_once_finished(self):
        self.state.save(1)
        news = FakeNews([sweep(2), sweep(3, "running"), sweep(4)], [card(20, 2), card(30, 3), card(40, 4)])
        posts = Posts()
        p.run(self.config, news, posts, self.state)
        self.assertEqual(self.state.load(), 2)
        self.assertNotIn("Story 40", "".join(posts.messages))  # Never skip past an unfinished sweep.
        news.sweeps[1]["status"] = "completed"
        p.run(self.config, news, posts, self.state)
        self.assertEqual(self.state.load(), 4)
        self.assertEqual([m.count("Story") for m in posts.messages], [1, 1, 1])

    def test_finished_sweeps_without_cards_advance_without_posting(self):
        self.state.save(1)
        news = FakeNews([sweep(2, "failed"), sweep(3, "no_news")])
        posts = Posts()
        self.assertEqual(p.run(self.config, news, posts, self.state)["messages"], 0)
        self.assertEqual(self.state.load(), 3)

    def test_a_failed_post_keeps_earlier_sweeps_and_retries_the_rest_next_run(self):
        self.state.save(1)
        news = FakeNews([sweep(2), sweep(3)], [card(20, 2), card(30, 3)])
        with self.assertRaises(p.PublisherError):
            p.run(self.config, news, Posts(fail_at=1), self.state)
        self.assertEqual(self.state.load(), 2)
        posts = Posts()
        p.run(self.config, news, posts, self.state)
        self.assertEqual(len(posts.messages), 1)
        self.assertIn("Story 30", posts.messages[0])

    def test_feed_paging_collects_every_card_and_stops_at_older_sweeps(self):
        self.state.save(1)
        cards = [card(i, 1) for i in range(1, 6)] + [card(i, 2) for i in range(6, 14)]
        news = FakeNews([sweep(1), sweep(2)], cards)
        posts = Posts()
        with mock.patch.object(p, "PAGE_SIZE", 3):
            p.run(self.config, news, posts, self.state)
        text = "".join(posts.messages)
        self.assertTrue(all(f"Story {i}**" in text for i in range(6, 14)))
        feed_pages = [c for c in news.calls if c[0] == "/v1/feed"]
        self.assertEqual(len(feed_pages), 3)  # The third page reaches sweep 1 and stops.

    def test_preview_shows_the_next_messages_without_saving(self):
        self.state.save(1)
        news = FakeNews([sweep(2)], [card(20, 2)])
        result = p.preview(self.config, news, self.state)
        self.assertEqual(result["sweeps"][0]["sweep_id"], 2)
        self.assertEqual(self.state.load(), 1)


class RenderTests(Base):
    def test_header_card_lines_ordering_and_escaping(self):
        cards = [card(1, 2, facts=40), card(2, 2, facts=90, title="@everyone *bold* <@1>")]
        [message] = p.render_sweep(sweep(2), cards, self.config)
        lines = message.split("\n")
        self.assertEqual(lines[0], "2026-10-30 News:")
        self.assertEqual(lines[1], "*2 news* - [Open in News](https://news.example.test/)")
        self.assertLess(message.index("everyone"), message.index("Story 1"))  # Facts descending.
        self.assertNotIn("@", message)
        self.assertIn("＠everyone \\*bold\\* \\<＠1\\>", message)
        self.assertIn("2026-10-30 09:00", message)  # Published time in Asia/Taipei.
        self.assertIn("*Facts* - `F: 90%; S: 40%; H: 10%`", message)

    def test_missing_publish_time_and_scores_degrade_gracefully(self):
        text = p.render_card(card(1, 2, publishedAt=None, hfs=None), "Asia/Taipei")
        self.assertIn("2026-10-30 10:00 (collected)", text)
        self.assertNotIn("F:", text)

    def test_long_cards_split_under_the_limit_without_losing_text(self):
        long = card(1, 2, props={"title": "Long", "dek": "word " * 1000})
        messages = p.render_sweep(sweep(2), [long, card(2, 2)], self.config)
        self.assertGreater(len(messages), 2)
        self.assertTrue(all(p.units(m) <= p.MAX_UNITS for m in messages))
        self.assertEqual("".join(messages).count("word"), 1000)

    def test_quote_and_release_components(self):
        quote = card(1, 2, component="quote", props={"quote": "Ship it", "speaker": "Ada"})
        self.assertTrue(p.render_card(quote, "UTC").endswith("Ship it — Ada"))
        release = card(2, 2, component="release", title="Tool",
                       props={"name": "Tool", "version": "2.0", "changes": ["Faster"]})
        self.assertIn("**Tool 2.0**", p.render_card(release, "UTC"))
        self.assertIn("• Faster", p.render_card(release, "UTC"))


class DiscordTests(unittest.TestCase):
    def test_post_disables_mentions_and_retries_only_rate_limits(self):
        calls = []

        def fake(request, timeout=15):
            calls.append(json.loads(request.data))
            if len(calls) == 1:
                raise p.HttpStatus(request.full_url, 429, "0")
            return {"id": "1"}

        with mock.patch.object(p, "http_json", fake), mock.patch.object(p.time, "sleep"):
            p.Discord("discord:" + CHANNEL, "synthetic-bot").post("hello", "n")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["allowed_mentions"], {"parse": []})

        def forbidden(request, timeout=15):
            raise p.HttpStatus(request.full_url, 403)

        with mock.patch.object(p, "http_json", forbidden), self.assertRaises(p.HttpStatus):
            p.Discord("discord:" + CHANNEL, "synthetic-bot").post("hello", "n")

    def test_bot_token_prefers_the_hermes_profile_over_the_environment(self):
        agent, secret, constants = (types.ModuleType(n) for n in
                                    ("agent", "agent.secret_scope", "hermes_constants"))
        secret.build_profile_secret_scope = lambda home: {"DISCORD_BOT_TOKEN": "profile-token"}
        constants.get_hermes_home = lambda: Path("synthetic-profile")
        modules = {"agent": agent, "agent.secret_scope": secret, "hermes_constants": constants}
        with mock.patch.dict(sys.modules, modules), \
                mock.patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "env-token"}):
            self.assertEqual(p.bot_token(), "profile-token")
        with mock.patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "env-token"}):
            self.assertEqual(p.bot_token(), "env-token")


class ConfigAndMainTests(Base):
    def write_config(self, token_mode=0o600, **overrides):
        directory = Path(self.tmp.name)
        token = directory / "read.token"
        token.write_text("synthetic-read-token\n")
        token.chmod(token_mode)
        config = {"base_url": "http://127.0.0.1:8765", "token_file": "read.token", "state_dir": "state",
                  "target": "discord:" + CHANNEL, "timezone": "Asia/Taipei",
                  "news_url": "https://news.example.test/", **overrides}
        path = directory / "client.json"
        path.write_text(json.dumps(config))
        return path

    def test_paths_resolve_next_to_the_config_and_bad_values_fail(self):
        config = p.load_config(self.write_config())
        self.assertEqual(config["token_file"], str(Path(self.tmp.name).resolve() / "read.token"))
        for bad in ({"target": "discord:123"}, {"base_url": "http://x.test/api"}, {"extra": 1},
                    {"timezone": "Mars/Base"}, {"news_url": "javascript:alert(1)"}):
            with self.subTest(bad=bad), self.assertRaises(p.PublisherError):
                p.load_config(self.write_config(**bad))

    def test_a_readable_token_file_is_rejected(self):
        p.load_config(self.write_config(token_mode=0o644))
        with self.assertRaises(p.PublisherError):
            p.read_token_file(Path(self.tmp.name) / "read.token")

    def test_run_writes_nothing_to_stdout_and_reports_on_stderr(self):
        path = self.write_config()
        news = FakeNews([sweep(1)], [card(10, 1)])
        discord = types.SimpleNamespace(post=Posts())
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = p.main(["--config", str(path)], news=news, discord=discord)
        self.assertEqual((code, out.getvalue()), (0, ""))
        self.assertEqual(json.loads(err.getvalue())["status"], "initialized")

    def test_errors_are_reported_without_secrets(self):
        path = self.write_config()
        news = FakeNews([sweep(1)])
        news.get = mock.Mock(side_effect=RuntimeError("synthetic-read-token leaked"))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(p.main(["--config", str(path)], news=news,
                                    discord=types.SimpleNamespace(post=Posts())), 1)
        self.assertEqual(json.loads(err.getvalue())["category"], "RuntimeError")
        self.assertNotIn("synthetic-read-token", err.getvalue())


if __name__ == "__main__":
    unittest.main()
