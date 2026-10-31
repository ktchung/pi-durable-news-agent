#!/usr/bin/env python3
"""Exercise the real API/hub entrypoints with fixture data and no provider keys.

This is a native-process smoke test, NOT Docker/VPN verification.
Requires an installed/built upstream checkout supplied with --source.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main(source, node_dir, ticker_check=False):
    client, cron = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    api_port, hub_port = free_port(), free_port()
    while hub_port == api_port:
        hub_port = free_port()
    # Never inherit provider keys, proxies or a root env file from Hermes.
    with tempfile.TemporaryDirectory(prefix="news-native-smoke-") as temp:
        env = {
            "PATH": str(node_dir) + os.pathsep + os.environ["PATH"],
            "HOME": temp, "TMPDIR": temp,
            "DNA_APP_ROOT": str(source), "DNA_ENV_FILE": "none",
            "DNA_DATA_DIR": str(Path(temp) / "data"), "DNA_LOG_DIR": str(Path(temp) / "logs"),
            "DNA_PROVIDER": "faux", "JEV_BACKEND": "fixture", "DNA_SEARCH_MODE": "fixture",
            "DNA_FIXTURE_SET": "news", "DNA_CLIENT_TOKEN": client, "DNA_CRON_TOKEN": cron,
            "DNA_HOST": "127.0.0.1", "DNA_PORT": str(api_port),
            "DNA_API_URL": f"http://127.0.0.1:{api_port}", "DNA_HUB_HOST": "127.0.0.1",
            "DNA_HUB_PORT": str(hub_port), "DNA_HUB_HOSTS": "news.example.test",
            "DNA_CRON_SCHEDULE": "* * * * *", "DNA_DEVICE_NAME": "smoke",
            "DNA_SWEEP_CRON": "0 */8 * * *", "DNA_SWEEP_TIMEZONE": "UTC",
        }
        base = f"http://127.0.0.1:{api_port}"
        hub_base = f"http://127.0.0.1:{hub_port}"
        procs = []
        logs = open(Path(temp) / "process.log", "w+")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, method="GET", body=None, token=client, hub=False, headers=None):
            hdr = {"Content-Type": "application/json"}
            if token:
                hdr["Authorization"] = "Bearer " + token
            if headers:
                hdr.update(headers)
            req = urllib.request.Request((hub_base if hub else base) + path,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers=hdr, method=method)
            try:
                with opener.open(req, timeout=5) as response:
                    raw = response.read()
                    return response.status, json.loads(raw) if "json" in response.headers.get("Content-Type", "") else raw
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())

        def start(role, overrides=None):
            proc = subprocess.Popen(["/bin/sh", str(ROOT / "docker/entrypoint.sh"), role],
                                    env={**env, **(overrides or {})}, stdout=logs, stderr=logs)
            procs.append(proc)
            return proc

        def wait(predicate, timeout=40):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                try:
                    result = predicate()
                    if result:
                        return result
                except (OSError, ValueError):
                    pass
                time.sleep(0.1)
            raise AssertionError("Smoke wait timed out")

        def stop(proc):
            proc.terminate()
            try:
                proc.wait(timeout=12)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
                raise AssertionError("Process did not exit cleanly")
            assert proc.returncode == 0, "Process shutdown was not clean"

        try:
            api = start("api")
            wait(lambda: request("/healthz", token=None)[0] == 200)
            hub = start("hub")
            wait(lambda: request("/hub/healthz", token=None, hub=True)[0] == 200)
            assert request("/v1/info", token=None)[0] == 401
            assert request("/v1/info", token=cron)[0] == 403
            initial_schedule = request("/v1/schedule")[1]
            assert initial_schedule["cronExpression"] == "0 */8 * * *"
            assert initial_schedule["timezone"] == "UTC"
            assert initial_schedule["schedulerStatus"] == "waiting"
            assert not initial_schedule.get("nextSweepAt"), "No countdown without a ticker"
            assert initial_schedule.get("nextScheduledAt")
            assert request("/v1/schedule", "PATCH", {"cronExpression": "* * * * *"}, token=cron)[0] == 403
            assert request("/v1/schedule", "PATCH", {"cronExpression": "invalid", "cardsPerSweep": 1})[0] == 400
            assert request("/v1/schedule")[1]["cardsPerSweep"] == initial_schedule["cardsPerSweep"]
            subprocess.run([str(node_dir / "node"), str(ROOT / "docker/control.mjs"),
                            "set-cron", "15 6,18 * * 1-5", "Europe/London"],
                           env=env, stdout=subprocess.DEVNULL, check=True, timeout=10)
            saved_schedule = request("/v1/schedule")[1]
            assert saved_schedule["cronExpression"] == "15 6,18 * * 1-5"
            assert saved_schedule["timezone"] == "Europe/London"
            assert request("/api/v1/info", token=None, hub=True,
                           headers={"Host": "news.example.test"})[0] == 200
            assert request("/api/v1/info", token=None, hub=True,
                           headers={"Host": "untrusted.example"})[0] == 421
            assert request("/api/v1/schedule", "PATCH", {"everyMinutes": None}, token=None, hub=True,
                           headers={"Host": "news.example.test", "Origin": "https://untrusted.example"})[0] == 403
            assert b"<html" in request("/", token=None, hub=True)[1].lower()
            for role in ("api", "hub"):
                subprocess.run([str(node_dir / "node"), str(ROOT / "docker/healthcheck.mjs"), role],
                               env=env, check=True, timeout=10)
            # Control helper performs a supported API write, then exact GET readback.
            subprocess.run([str(node_dir / "node"), str(ROOT / "docker/control.mjs"), "pause"],
                           env=env, stdout=subprocess.DEVNULL, check=True, timeout=10)
            assert request("/v1/schedule")[1]["everyMinutes"] is None
            assert request("/v1/schedule")[1]["cronExpression"] is None
            body = {"requestId": "fixture:container-smoke", "trigger": "test", "scheduled": False, "cards": 1}
            assert request("/v1/workflows/news-sweep", "POST", body)[0] == 403
            status, accepted = request("/v1/workflows/news-sweep", "POST", body, token=cron)
            assert status == 202 and accepted["status"] == "accepted"
            sweep_id = accepted["sweep"]["id"]
            sweep = wait(lambda: (lambda s: s if s["status"] in ("completed", "no_news", "stalled", "failed") else None)(
                request(f"/v1/sweeps/{sweep_id}")[1]))
            assert sweep["status"] == "completed", sweep["status"]
            assert sweep["audit"]["missing"] == []
            feed_before = request("/v1/feed")[1]["items"]
            assert feed_before, "Fixture sweep produced no cards"
            ids_before = [card["id"] for card in feed_before]
            replay = request("/v1/workflows/news-sweep", "POST", body, token=cron)[1]
            assert replay["status"] == "replay"
            assert request("/v1/feed")[1]["items"] == feed_before
            stop(api)
            api = start("api")
            wait(lambda: request("/healthz", token=None)[0] == 200)
            assert request("/v1/schedule")[1]["everyMinutes"] is None
            assert request("/v1/schedule")[1]["cronExpression"] is None
            assert request("/v1/schedule")[1]["timezone"] == "Europe/London"
            assert [card["id"] for card in request("/v1/feed")[1]["items"]] == ids_before
            assert request(f"/v1/sweeps/{sweep_id}")[1]["status"] == "completed"
            assert request("/api/v1/info", token=None, hub=True,
                           headers={"Host": "news.example.test"})[0] == 200
            if ticker_check:
                # Real minute boundary, real ticker/CLI/authenticated workflow,
                # but isolated faux inference and fixture Jev/search only.
                assert request("/v1/schedule", "PATCH", {
                    "cronExpression": "* * * * *", "timezone": "UTC", "cardsPerSweep": 1,
                })[0] == 200
                ticker = start("ticker", {"DNA_AUTOMATION_ENABLED": "true"})
                wait(lambda: request("/v1/schedule")[1].get("lastTickAt"), timeout=75)
                live_schedule = request("/v1/schedule")[1]
                assert live_schedule["schedulerStatus"] == "running"
                assert live_schedule.get("nextSweepAt")
                automatic = wait(lambda: next((s for s in request("/v1/sweeps")[1]
                                               if s["trigger"] == "cron"), None))
                stop(ticker)
                automatic_done = wait(lambda: (lambda s: s if s["status"] in (
                    "completed", "no_news", "stalled", "failed") else None)(
                    request(f'/v1/sweeps/{automatic["id"]}')[1]))
                assert automatic_done["status"] in ("completed", "no_news"), automatic_done["status"]
                assert automatic_done["audit"]["missing"] == []
                assert request("/v1/schedule", "PATCH", {"cronExpression": None})[0] == 200
            print(json.dumps({"native_fixture_smoke": "passed", "paid_calls": 0,
                              "api_auth_and_scope": "passed", "hub_host_origin_and_static_ui": "passed",
                              "healthchecks_and_control_helper": "passed", "sweep": sweep["status"],
                              "idempotent_replay": "passed", "restart_persistence": "passed",
                              "cron_settings_auth_and_persistence": "passed",
                              "real_minute_ticker_fixture_workflow": "passed" if ticker_check else "not requested"}, indent=2))
        except BaseException:
            # Only this isolated fixture log is printed, never real deployment logs.
            logs.flush()
            logs.seek(0)
            print(logs.read()[-16000:])
            raise
        finally:
            for proc in reversed(procs):
                if proc.poll() is None:
                    stop(proc)
            logs.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=os.environ.get("DNA_TEST_SOURCE"))
    parser.add_argument("--node-dir", type=Path, required=True)
    parser.add_argument("--ticker", action="store_true", help="Exercise a real minute-boundary ticker with fixture providers only")
    args = parser.parse_args()
    if args.source is None:
        parser.error("Supply --source or DNA_TEST_SOURCE with an installed, built fixture checkout")
    main(args.source.resolve(), args.node_dir.resolve(), args.ticker)
