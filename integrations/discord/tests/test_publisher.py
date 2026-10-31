"""Risk-based, credential-free HTTP fixtures; no production services imported."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publisher", ROOT / "publisher.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
TARGET = "discord:100000000000000001"
NEWS_URL = "https://news.example.test/"


def sweep(i, count=1, status="completed", missing=None):
    return {"id": i, "status": status, "presented": count,
            "audit": {"missing": [] if missing is None else missing},
            "endedAt": "2026-10-30T00:00:00Z"}


def card(i, sid, component="brief", props=None):
    return {"id": i, "kind": "news", "sweepId": sid, "component": component,
            "publishedAt": "2026-10-29T18:52:46Z", "createdAt": "2026-10-30T00:00:00Z",
            "hfs": {"facts": 80, "signal": 50, "hype": 5, "primary": "facts"},
            "title": "Original English title", "props": props or {
                "title": "Model title @everyone <@123456789012345678>",
                "summary": "Original model summary **not a translation**"},
            "url": f"https://example.test/item/{i}", "sourceName": "Original source",
            "sources": [{"title": "Supporting source", "url": "https://evidence.test/a?q=<x>@here",
                         "sourceName": "Evidence"}]}


class Fixture:
    def __init__(self):
        self.sweeps = [sweep(1)]
        self.cards = [card(1, 1)]
        self.calls = []
        self.mode = "normal"
        self.sweep_details = {}
        self.card_details = {}

    @contextlib.contextmanager
    def serve(self, root):
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                parsed = urlsplit(self.path)
                fixture.calls.append(("GET", parsed.path, parse_qs(parsed.query)))
                if self.headers.get("Authorization") != "Bearer synthetic-test-token":
                    self.send_error(401)
                    return
                if fixture.mode == "http_failure":
                    self.send_error(503)
                    return
                if fixture.mode == "redirect":
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/must-not-follow")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                q = parse_qs(parsed.query)
                limit = int(q.get("limit", [2])[0])
                before = int(q.get("before", [10**9])[0])
                if parsed.path == "/v1/sweeps":
                    result = sorted([s for s in fixture.sweeps if s["id"] < before],
                                    key=lambda s: -s["id"])[:limit]
                elif parsed.path.startswith("/v1/sweeps/"):
                    sid = int(parsed.path.rsplit("/", 1)[1])
                    result = fixture.sweep_details.get(sid)
                    if result is None:
                        result = {**next(s for s in fixture.sweeps if s["id"] == sid),
                                  "toolCalls": [{"toolName": "present_news", "status": "done",
                                                 "isError": False, "details": {"cardId": c["id"]}}
                                                for c in fixture.cards if c["sweepId"] == sid]}
                elif parsed.path == "/v1/feed":
                    rows = sorted([c for c in fixture.cards if c["id"] < before
                                   and not c.get("hiddenFromFeed")],
                                  key=lambda c: -c["id"])[:limit]
                    rows.reverse()
                    if fixture.mode == "duplicate_feed" and len(rows) == 1:
                        rows.append(rows[0])
                    result = {"items": rows}
                    if len(rows) == limit:
                        result["cursor"] = str(rows[0]["id"])
                    if fixture.mode == "bad_cursor" and rows:
                        result["cursor"] = str(before)
                elif parsed.path.startswith("/v1/cards/"):
                    cid = int(parsed.path.rsplit("/", 1)[1])
                    value = fixture.card_details.get(cid)
                    if value is None:
                        value = next(c for c in fixture.cards if c["id"] == cid)
                    result = {"card": value, "item": {"id": cid, "url": value["url"],
                              "title": "Original item title", "sourceName": "Item source"}}
                else:
                    self.send_error(404)
                    return
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        token = root / "fixture-token"
        token.write_text("synthetic-test-token\n")
        token.chmod(0o600)
        config = root / "client.json"
        config.write_text(json.dumps({"base_url": f"http://127.0.0.1:{server.server_port}",
                                     "token_file": "fixture-token", "state_dir": "state",
                                     "target": TARGET, "news_url": NEWS_URL,
                                     "timezone": "Asia/Taipei"}))
        try:
            yield config
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="publisher-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixture = Fixture()
        self.config = self.enterContext(self.fixture.serve(self.root))
        self.client = p.GetClient(self.config)
        self.publisher = p.Publisher(self.client, self.root / "state", page_size=2,
                                     target=TARGET, news_url=NEWS_URL)
        self.addCleanup(self.publisher.close)

    def seed(self):
        return self.publisher.baseline()

    def add(self, sid, component="brief", props=None):
        self.fixture.sweeps.append(sweep(sid))
        self.fixture.cards.append(card(sid, sid, component, props))

    def receipt(self, claimed):
        return {"outbox_id": claimed["outbox_id"], "claim_token": claimed["claim_token"],
                "target": TARGET, "status": "delivered", "verified": True,
                "verification": "discord-readback",
                "messages": [{"index": n, "message_id": str(123456789012345678 + n),
                              "content_sha256": m["content_sha256"],
                              "readback_content_sha256": m["content_sha256"]}
                             for n, m in enumerate(claimed["messages"])]}

    def test_explicit_baseline_no_historical_flood_or_delivery(self):
        self.fixture.sweeps = [sweep(i) for i in range(1, 26)] + [sweep(26, status="running")]
        self.fixture.cards = [card(i, i) for i in range(1, 27)]
        self.assertEqual(self.publisher.prepare()["status"], "needs_baseline")
        run = subprocess.run([sys.executable, str(ROOT / "publisher.py"), "--config", str(self.config), "tick"],
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        result = json.loads(run.stderr)
        self.assertEqual(result["status"], "needs_baseline")
        self.assertIsNone(self.publisher.status()["baseline"])
        result = self.publisher.baseline()
        self.assertEqual(result["status"], "baseline_established")
        self.assertEqual(result["skipped_sweeps"], 25)
        self.assertFalse(result["delivery_confirmed"])
        self.assertEqual(self.publisher.prepare()["status"], "idle")
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.fixture.sweeps[-1]["status"] = "completed"
        prepared = self.publisher.prepare()
        self.assertEqual(prepared["card_ids"], [26])
        self.assertGreater(prepared["scan"]["sweep_pages"], 1)
        self.assertGreater(prepared["scan"]["feed_pages"], 1)

    def test_approved_card_layout_sorting_local_dates_single_link_and_whole_card_chunks(self):
        self.fixture.sweeps = [{**sweep(1, 3), 'endedAt': '2026-10-30T20:00:00Z'}]
        self.fixture.cards = [card(i, 1, props={'title': f'Card {i}', 'summary': str(i) * 600})
                              for i in (1, 2, 3)]
        for value, facts, signal in zip(self.fixture.cards, (80, 95, 95), (50, 90, 97)):
            value['hfs'].update(facts=facts, signal=signal)
        before = list(self.publisher.db.iterdump())
        result = self.publisher.preview_latest()
        self.assertEqual(result['card_ids'], [3, 2, 1])
        messages = [m['content'] for m in result['messages']]
        text = '\n'.join(messages)
        self.assertTrue(text.startswith(f'2026-10-31 News:\n*3 news* - [Open in News]({NEWS_URL})\n\n---\n'))
        self.assertEqual(text.count('[Open in News]'), 1)
        self.assertIn('Original source: **Card 3**\n2026-10-30 02:52\n*Signal* - `F: 95%; S: 97%; H: 5%`', text)
        self.assertNotIn('https://example.test', text)
        for i in (1, 2, 3):
            self.assertTrue(any(f'**Card {i}**' in m and str(i) * 600 in m for m in messages))
        self.assertTrue(all(p.units(m) <= p.MAX_UNITS for m in messages))
        self.assertEqual(list(self.publisher.db.iterdump()), before)
        self.fixture.cards[0]['publishedAt'] = None
        self.assertIn('2026-10-30 08:00 (collected)', '\n'.join(
            m['content'] for m in self.publisher.preview_latest()['messages']))
        self.fixture.cards[0]['hfs']['facts'] = 101
        with self.assertRaises(p.PublisherError):
            self.publisher.preview_latest()
        self.assertEqual(list(self.publisher.db.iterdump()), before)

    def test_cutover_baseline_skips_only_older_sweeps_without_delivery(self):
        self.add(2)
        self.add(3)
        result = self.publisher.baseline(before_sweep_id=3)
        self.assertEqual(result['skipped_sweeps'], 2)
        self.assertEqual(self.publisher.status()['baseline']['before_sweep_id'], 3)
        self.assertEqual(self.publisher.status()['delivered_cards'], 0)
        self.assertEqual(self.publisher.prepare()['card_ids'], [3])
        with self.assertRaises(p.PublisherError):
            self.publisher.baseline(before_sweep_id=4)

    def test_multiple_completed_sweeps_all_cards_ack_dedupe(self):
        self.seed()
        self.add(2)
        self.add(3)
        self.fixture.sweeps.append(sweep(4, status="running"))
        self.fixture.cards.append(card(4, 4))
        self.fixture.sweeps.append(sweep(5, missing=["hfs"]))
        self.fixture.cards.append(card(5, 5))
        prepared = self.publisher.prepare()
        self.assertEqual(prepared["sweep_ids"], [2, 3])
        self.assertEqual(prepared["card_ids"], [2, 3])
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        claimed = self.publisher.claim(prepared["outbox_id"])
        text = "\n".join(m["content"] for m in claimed["messages"])
        self.assertEqual(text.count("2026-10-30 News:"), 2)
        self.assertEqual(text.count("[Open in News]"), 2)
        self.assertNotIn("@everyone", text)
        self.assertNotIn("<@", text)
        self.assertIn("Original model summary", text)
        self.assertNotIn("https://example.test/item/2", text)
        self.assertIn("%3Cx%3E%40here", p.safe_url("https://evidence.test/a?q=<x>@here"))
        for m in claimed["messages"]:
            self.assertLessEqual(len(m["content"].encode("utf-16-le")) // 2, 1800)
            self.assertEqual(m["allowed_mentions"]["parse"], [])
        receipt = self.receipt(claimed)
        self.assertEqual(self.publisher.ack(receipt)["status"], "confirmed")
        self.assertEqual(self.publisher.ack(receipt)["status"], "confirmed")
        # The upstream feed may hide acknowledged historical cards later.
        self.fixture.cards = [c for c in self.fixture.cards if c["sweepId"] not in (2, 3)]
        self.assertEqual(self.publisher.prepare()["status"], "idle")
        self.assertEqual(self.publisher.status()["delivered_cards"], 2)
        self.assertTrue(all(method == "GET" for method, _, _ in self.fixture.calls))

    def test_count_mismatch_and_broken_pagination_fail_closed(self):
        self.fixture.sweeps[0]["presented"] = 2
        with self.assertRaisesRegex(p.PublisherError, "cardinality"):
            self.publisher.baseline()
        self.assertIsNone(self.publisher.status()["baseline"])
        self.fixture.sweeps[0]["presented"] = 1
        self.seed()
        self.add(2)
        self.fixture.sweeps[-1]["presented"] = 2
        with self.assertRaisesRegex(p.PublisherError, "cardinality"):
            self.publisher.prepare()
        self.assertEqual(self.publisher.status()["outboxes"], [])
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.fixture.sweeps[-1]["presented"] = 1
        self.fixture.mode = "bad_cursor"
        with self.assertRaises(p.PublisherError):
            self.publisher.prepare()
        self.assertEqual(self.publisher.status()["outboxes"], [])

    def hidden_batch(self):
        self.fixture.sweeps.append(sweep(2, 2))
        self.fixture.cards.extend([card(20, 2), {**card(97, 2, "release", {
            "name": "Hidden package", "version": "2.0", "changes": ["Original hidden change"]}),
            "hiddenFromFeed": True}])
        return {**sweep(2, 2), "toolCalls": [
            {"toolName": "present_news", "status": "done", "isError": False,
             "details": {"cardId": cid}} for cid in (20, 97)]}

    def test_hidden_cards_recovered_by_exact_audit_ids_without_delivery(self):
        self.seed()
        self.fixture.sweep_details[2] = self.hidden_batch()
        self.fixture.sweep_details[2]["toolCalls"].extend([
            {"toolName": "present_news", "status": "done", "isError": True, "details": {"cardId": 500}},
            {"toolName": "present_news", "status": "running", "isError": False, "details": {"cardId": 501}},
            {"toolName": "fetch_news", "status": "done", "isError": False, "details": {"cardId": 502}},
        ])
        preview = self.publisher.preview_latest()
        self.assertEqual(preview["card_ids"], [20, 97])
        self.assertEqual(self.publisher.status()["outboxes"], [])
        prepared = self.publisher.prepare()
        self.assertEqual(prepared["sweep_ids"], [2])
        self.assertEqual(prepared["card_ids"], [20, 97])
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.assertEqual(self.publisher.prepare()["status"], "blocked")
        payload = self.publisher.show(prepared["outbox_id"])
        self.assertIn("Original hidden change", "\n".join(m["content"] for m in payload["messages"]))
        self.assertEqual({path for _, path, _ in self.fixture.calls if path.startswith("/v1/cards/")},
                         {"/v1/cards/20", "/v1/cards/97"})
        self.assertFalse(any(path == "/v1/sweeps/1" for _, path, _ in self.fixture.calls))

    def test_hidden_without_independent_recovery_still_fails_closed(self):
        self.fixture.card_details[1] = {**self.fixture.cards[0], "hiddenFromFeed": True}
        before = list(self.publisher.db.iterdump())
        with self.assertRaisesRegex(p.PublisherError, "hidden during collection"):
            self.publisher.preview_latest()
        self.assertEqual(list(self.publisher.db.iterdump()), before)
        self.assertFalse(any(path.startswith("/v1/sweeps/") for _, path, _ in self.fixture.calls))

    def test_hidden_baseline_validates_membership_without_rendering_history(self):
        self.fixture.sweep_details[2] = self.hidden_batch()
        self.fixture.cards[-1]["props"] = {}  # Historical bodies need not be renderable.
        result = self.publisher.baseline()
        self.assertEqual(result["skipped_cards"], 3)
        self.assertEqual(self.publisher.status()["baseline"]["card_ids"], [1, 20, 97])
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.assertEqual(self.publisher.prepare()["status"], "idle")

    def test_hidden_recovery_rejects_incomplete_foreign_or_changed_evidence_atomically(self):
        self.seed()
        good = self.hidden_batch()
        before = list(self.publisher.db.iterdump())
        cases = ["foreign_sweep", "foreign_card", "wrong_card_id", "truncated", "error",
                 "pending", "wrong_tool", "missing_error_flag", "invalid_id", "duplicate",
                 "missing_visible", "extra_reference", "changed_visible", "changed_sweep"]
        for case in cases:
            with self.subTest(case=case):
                detail = copy.deepcopy(good)
                self.fixture.card_details = {}
                if case == "foreign_sweep":
                    detail["id"] = 9
                elif case in ("foreign_card", "wrong_card_id"):
                    hidden = copy.deepcopy(self.fixture.cards[-1])
                    hidden["sweepId" if case == "foreign_card" else "id"] = 9
                    self.fixture.card_details[97] = hidden
                elif case == "truncated":
                    detail["toolCalls"].pop()
                elif case == "error":
                    detail["toolCalls"][-1]["isError"] = True
                elif case == "pending":
                    detail["toolCalls"][-1]["status"] = "running"
                elif case == "wrong_tool":
                    detail["toolCalls"][-1]["toolName"] = "fetch_news"
                elif case == "missing_error_flag":
                    del detail["toolCalls"][-1]["isError"]
                elif case == "invalid_id":
                    detail["toolCalls"][-1]["details"]["cardId"] = "97"
                elif case == "duplicate":
                    detail["toolCalls"][-1] = copy.deepcopy(detail["toolCalls"][0])
                elif case == "missing_visible":
                    detail["toolCalls"][0]["details"]["cardId"] = 1
                elif case == "extra_reference":
                    detail["toolCalls"].append({**detail["toolCalls"][0], "details": {"cardId": 1}})
                elif case == "changed_visible":
                    visible = copy.deepcopy(self.fixture.cards[-2])
                    visible["props"]["summary"] = "Changed after feed scan"
                    self.fixture.card_details[20] = visible
                elif case == "changed_sweep":
                    detail["presented"] = 1
                self.fixture.sweep_details[2] = detail
                self.fixture.calls.clear()
                with self.assertRaises(p.PublisherError):
                    self.publisher.prepare()
                self.assertEqual(list(self.publisher.db.iterdump()), before)
                self.assertTrue({path for _, path, _ in self.fixture.calls if path.startswith("/v1/cards/")}
                                <= {"/v1/cards/20", "/v1/cards/97"})

    def test_unknown_failure_and_restart_never_auto_resend(self):
        self.seed()
        self.add(2)
        prepared = self.publisher.prepare()
        self.assertEqual(self.publisher.prepare()["status"], "blocked")
        claimed = self.publisher.claim(prepared["outbox_id"])
        with self.assertRaises(p.PublisherError):
            self.publisher.claim(prepared["outbox_id"])
        self.publisher.record_failure(prepared["outbox_id"], claimed["claim_token"], "timeout: outcome unknown")
        self.publisher.close()
        self.publisher = p.Publisher(self.client, self.root / "state", page_size=2,
                                     target=TARGET, news_url=NEWS_URL)
        self.addCleanup(self.publisher.close)
        self.assertEqual(self.publisher.prepare()["status"], "blocked")
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.assertEqual(self.publisher.ack(self.receipt(claimed))["status"], "confirmed")

    def test_partial_wrong_or_unverified_receipts_never_ack(self):
        self.seed()
        self.add(2, props={"title": "Model title", "summary": "🙂" * 2500})
        self.add(3)
        claimed = self.publisher.claim(self.publisher.prepare()["outbox_id"])
        self.assertGreater(len(claimed["messages"]), 1)
        good = self.receipt(claimed)
        bads = []
        for key, value in [("verified", False), ("target", "discord:999"), ("claim_token", "wrong")]:
            changed = copy.deepcopy(good)
            changed[key] = value
            bads.append(changed)
        partial = copy.deepcopy(good)
        partial["messages"].pop()
        bads.append(partial)
        bad_hash = copy.deepcopy(good)
        bad_hash["messages"][0]["readback_content_sha256"] = "0" * 64
        bads.append(bad_hash)
        for bad in bads:
            with self.assertRaises(p.PublisherError):
                self.publisher.ack(bad)
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.assertEqual(self.publisher.prepare()["status"], "blocked")
        self.publisher.db.execute("""CREATE TRIGGER fixture_abort AFTER INSERT ON delivered
            WHEN NEW.card_id=3 BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END""")
        with self.assertRaises(sqlite3.Error):
            self.publisher.ack(good)
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)
        self.assertEqual(self.publisher.status()["outboxes"][0]["status"], "claimed")
        self.publisher.db.execute("DROP TRIGGER fixture_abort")
        self.publisher.ack(good)
        self.assertEqual(self.publisher.status()["delivered_cards"], 2)

    def test_component_sources_preview_readonly_and_invalid_sources(self):
        variants = {
            "headline": {"title": "Model headline", "dek": "Original dek"},
            "brief": {"title": "Model brief", "summary": "Original summary"},
            "signal_alert": {"title": "Model alert", "action": "Original action", "why": "Original why"},
            "fact_check": {"claim": "Original claim", "verdict": "Original verdict", "evidence": ["Evidence one"]},
            "hype_watch": {"title": "Model hype", "reality_check": "Original reality"},
            "release": {"name": "Package", "version": "1.2", "changes": ["Original change"]},
            "thread_pulse": {"title": "Model thread", "takes": [{"name": "Author", "text": "Original take"}]},
            "quote": {"quote": "Original quote", "speaker": "Original speaker"},
        }
        self.fixture.sweeps = [sweep(1, len(variants))]
        self.fixture.cards = [card(i, 1, name, props) for i, (name, props) in enumerate(variants.items(), 1)]
        result = self.publisher.preview_latest()
        self.assertEqual(result["card_ids"], list(range(1, 9)))
        self.assertEqual(self.publisher.status()["outboxes"], [])
        self.assertIsNone(self.publisher.status()["baseline"])
        text = "\n".join(m["content"] for m in result["messages"])
        for fragment in ["Original dek", "Original why", "Evidence one", "Original change", "Original take", "Original speaker"]:
            self.assertIn(fragment, text)
        self.fixture.cards[-1]["url"] = "javascript:alert(1)"
        with self.assertRaises(p.PublisherError):
            self.publisher.preview_latest()
        self.assertIsNone(self.publisher.status()["baseline"])

    def test_network_failure_preserves_baseline_and_silent_tick_stdout(self):
        self.seed()
        before = self.publisher.status()
        self.fixture.mode = "http_failure"
        with self.assertRaises(p.PublisherError):
            self.publisher.prepare()
        self.assertEqual(before, self.publisher.status())
        command = [sys.executable, str(ROOT / "publisher.py"), "--config", str(self.config), "tick"]
        failed = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(failed.stdout, "")
        self.assertEqual(before, self.publisher.status())
        self.fixture.mode = "normal"
        run = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        self.add(2)
        run = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        self.assertEqual(self.publisher.status()["delivered_cards"], 0)

    def test_portable_config_validation_and_target_bound_immutable_outbox(self):
        config = p.load_config(self.config)
        self.assertEqual(Path(config['token_file']), self.root / 'fixture-token')
        self.assertEqual(Path(config['state_dir']), self.root / 'state')
        settings = json.loads(self.config.read_text())
        for field, invalid in [('target', 'discord:123'), ('timezone', 'Not/AZone'),
                               ('news_url', 'javascript:invalid'),
                               ('base_url', 'https://example.test/not-an-origin'),
                               ('target', 100000000000000001)]:
            with self.subTest(field=field, invalid=invalid):
                self.config.write_text(json.dumps({**settings, field: invalid}))
                with self.assertRaises(p.PublisherError):
                    p.load_config(self.config)
        self.config.write_text(json.dumps(settings))
        self.seed()
        self.add(2)
        prepared = self.publisher.prepare()
        frozen = self.publisher.show(prepared['outbox_id'])
        moved = p.Publisher(None, self.root / 'state', target='discord:100000000000000002',
                            news_url='https://other.example.test/')
        try:
            with self.assertRaises(p.PublisherError):
                moved.claim(prepared['outbox_id'])
            self.assertEqual(moved.show(prepared['outbox_id']), frozen)
        finally:
            moved.close()
        # Local inspection requires neither the read token nor a network client.
        (self.root / 'fixture-token').unlink()
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        calls = list(self.fixture.calls)
        result = subprocess.run([sys.executable, str(ROOT / 'publisher.py'), '--config',
                                 str(self.config), 'status'], cwd=elsewhere,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['outboxes'][0]['status'], 'prepared')
        self.assertEqual(self.fixture.calls, calls)

    def test_get_transport_rejects_mutations_redirects_and_insecure_token(self):
        with self.assertRaises(p.PublisherError):
            self.client.get("/v1/workflows/news-sweep")
        self.fixture.mode = "redirect"
        with self.assertRaises(p.PublisherError):
            self.client.get("/v1/sweeps")
        self.assertFalse(any(path == "/must-not-follow" for _, path, _ in self.fixture.calls))
        self.fixture.mode = "duplicate_feed"
        preview = self.publisher.preview_latest()
        self.assertEqual(preview["card_ids"], [1])
        self.assertEqual(preview["scan"]["duplicate_records"], 1)
        token = self.root / "fixture-token"
        token.chmod(0o644)
        with self.assertRaises(p.PublisherError):
            p.GetClient(self.config)
        with self.assertRaises(p.PublisherError):
            p.safe_url("https://user:password@example.test/a")
        with self.assertRaises(p.PublisherError):
            p.safe_url("https://example.test/a\n@everyone")


if __name__ == "__main__":
    unittest.main()
