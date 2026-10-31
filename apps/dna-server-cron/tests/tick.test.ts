import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  bootServer,
  freePort,
  settledSweep,
  type Booted,
} from "../../dna-server-api/tests/server.ts";
import { slotMinutes } from "../src/schedule.ts";
import { slotId } from "../src/tick.ts";

const MAIN = resolve(import.meta.dirname, "../src/main.ts");
let s: Booted;
let logs: string;
before(async () => {
  s = await bootServer();
  logs = mkdtempSync(join(tmpdir(), "dna-cron-"));
});
after(async () => {
  await s.cleanup();
  rmSync(logs, { recursive: true, force: true });
});

function runTick(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "tick"], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DNA_ENV_FILE: "none",
      DNA_LOG_DIR: logs,
      DNA_DEVICE_NAME: "test",
      DNA_CRON_BACKOFF_MS: "20,20,20",
      // An hour slot, so two ticks in a row share one requestId.
      DNA_CRON_SCHEDULE: "0 * * * *",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const attempts = () =>
  readFileSync(join(logs, "cron.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "cron.attempt");

test("slots floor to the tick in UTC", () => {
  assert.equal(slotId("mini", new Date("2026-10-12T16:14:59Z")), "cron:mini:20261012T1600");
  assert.equal(slotId("mini", new Date("2026-10-12T16:15:00Z")), "cron:mini:20261012T1615");
  assert.equal(slotId("mini", new Date("2026-10-12T16:14:59Z"), 5), "cron:mini:20261012T1610");
  assert.equal(slotMinutes("*/5 * * * *"), 5);
  assert.equal(slotMinutes("* * * * *"), 1);
  assert.equal(slotMinutes("7 * * * *"), 60);
});

test("the first tick gets 202, a second tick in the same slot replays the same sweep", async () => {
  // Transport replay is independent of the production eight-hour sweep default.
  await s.client.setSchedule({ cronExpression: "* * * * *", timezone: "UTC" });
  const first = runTick({ DNA_API_URL: s.base, DNA_CRON_TOKEN: s.tokens.cron });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /accepted sweep 1/);
  const second = runTick({ DNA_API_URL: s.base, DNA_CRON_TOKEN: s.tokens.cron });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /replay sweep 1/);
  const lines = attempts();
  assert.deepEqual(
    lines.map((l) => [l.status, l.outcome, l.sweepId]),
    [
      [202, "accepted", 1],
      [200, "replay", 1],
    ],
  );
  assert.ok(lines.every((l) => typeof l.ms === "number" && l.slot.startsWith("cron:test:")));
  assert.equal((await settledSweep(s.client, 1)).status, "completed");
  const transcript = await s.client.transcript();
  assert.ok(
    transcript.items!.some((i) => i.kind === "user" && /Run scheduled sweep 1/.test(i.text)),
    "the chat shows the scheduled sweep",
  );
});

test("the API down: 4 attempts (2 s, 8 s, 30 s backoff, scaled down here) and exit 1", async () => {
  const before = attempts().length;
  const down = runTick({
    DNA_API_URL: `http://127.0.0.1:${await freePort()}`,
    DNA_CRON_TOKEN: s.tokens.cron,
  });
  assert.equal(down.code, 1);
  assert.match(down.out, /failed after 4 attempts/);
  const lines = attempts().slice(before);
  assert.deepEqual(
    lines.map((l) => l.attempt),
    [1, 2, 3, 4],
  );
  assert.ok(lines.every((l) => l.error && l.status === undefined));
});

test("a misconfigured client token is refused with 403, without retries", async () => {
  const before = attempts().length;
  const wrong = runTick({ DNA_API_URL: s.base, DNA_CRON_TOKEN: s.tokens.client });
  assert.equal(wrong.code, 1);
  const lines = attempts().slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 403);
  assert.match(lines[0].error, /workflow scope/);
  assert.ok(
    !readFileSync(join(logs, "cron.jsonl"), "utf8").includes(s.tokens.cron),
    "no token in the log",
  );
});
