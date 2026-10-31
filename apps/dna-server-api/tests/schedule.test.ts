import assert from "node:assert/strict";
import { test } from "node:test";
import { Schedule } from "../src/news/schedule.ts";
import { loadConfig } from "../src/config.ts";
import { tempStore } from "./helpers.ts";

test("sweep environment seeds are distinct from the every-minute transport tick", () => {
  const defaults = loadConfig([], {});
  assert.equal(defaults.sweepCron, "0 */8 * * *");
  assert.equal(defaults.sweepTimezone, "UTC");
  assert.equal(defaults.cronSchedule, "* * * * *");
  assert.equal(loadConfig([], { TZ: "Europe/London" }).sweepTimezone, "Europe/London");
  const configured = loadConfig([], {
    DNA_SWEEP_CRON: "15 9 * * MON-FRI",
    DNA_SWEEP_TIMEZONE: "Asia/Hong_Kong",
    TZ: "Europe/London",
  });
  assert.equal(configured.sweepCron, "15 9 * * MON-FRI");
  assert.equal(configured.sweepTimezone, "Asia/Hong_Kong");
  assert.equal(configured.cronSchedule, "* * * * *");
});

test("eight-hour seed and one-time legacy migration preserve off, cards and canonical settings", () => {
  const { store, cleanup } = tempStore();
  try {
    const deps = { store, cronSchedule: "* * * * *", sweepTimezone: "UTC" };
    const first = new Schedule(deps);
    assert.equal(first.state().cronExpression, "0 */8 * * *");
    assert.equal(first.every(), 480);
    store.settings.set("schedule", { everyMinutes: 5, cardsPerSweep: 12 });
    const migrated = new Schedule(deps);
    assert.equal(migrated.state().cronExpression, "0 */8 * * *");
    assert.equal(migrated.cards(), 12);
    migrated.set({ cronExpression: "15 9 * * MON-FRI", timezone: "Asia/Hong_Kong" });
    const before = store.db.prepare("SELECT * FROM settings WHERE key = 'schedule'").get();
    const changes = store.db.prepare("SELECT total_changes() AS n").get();
    for (let i = 0; i < 3; i++) migrated.state();
    assert.deepEqual(
      store.db.prepare("SELECT * FROM settings WHERE key = 'schedule'").get(),
      before,
    );
    assert.deepEqual(
      store.db.prepare("SELECT total_changes() AS n").get(),
      changes,
      "GET makes no writes",
    );
    const restarted = new Schedule({
      ...deps,
      sweepCron: "* * * * *",
      sweepTimezone: "Europe/London",
    });
    assert.equal(restarted.state().cronExpression, "15 9 * * MON-FRI");
    assert.equal(restarted.state().timezone, "Asia/Hong_Kong");
    assert.equal(restarted.every(), null, "custom cron is not representable as a fixed interval");
    store.settings.set("schedule", { everyMinutes: null, cardsPerSweep: 9 });
    const off = new Schedule(deps);
    assert.equal(off.state().cronExpression, null);
    assert.equal(off.cards(), 9);
    assert.equal(off.next(), undefined);
    assert.equal(new Schedule(deps).state().cronExpression, null);
    store.settings.set("schedule", { everyMinutes: 30, cardsPerSweep: 4 });
    assert.equal(
      new Schedule({ ...deps, sweepCron: "15 9 * * MON-FRI" }).state().cronExpression,
      "15 9 * * MON-FRI",
    );
  } finally {
    cleanup();
  }
});

test("only matching minutes are due; no startup/change catch-up and durable same-minute dedupe", () => {
  const { store, cleanup } = tempStore();
  try {
    const deps = { store, cronSchedule: "* * * * *", sweepTimezone: "UTC" };
    const schedule = new Schedule(deps);
    const at = (iso: string) => Date.parse(`2026-10-29T${iso}Z`);
    for (const time of ["07:59:59.999", "08:01:00", "15:59:59.999"])
      assert.equal(schedule.due(at(time)).due, false, time);
    assert.equal(schedule.due(at("08:00:00")).due, true);
    assert.equal(schedule.due(at("08:00:59.999")).due, true);
    assert.equal(schedule.nextScheduled(at("08:00:00"))!.toISOString(), "2026-10-29T16:00:00.000Z");
    assert.equal(schedule.next(at("08:00:00")), undefined);
    schedule.recordStarted(at("08:00:30"));
    assert.equal(schedule.due(at("08:00:59")).due, false);
    assert.equal(
      new Schedule(deps).due(at("08:00:59")).due,
      false,
      "restart keeps the claimed minute",
    );
    schedule.set({ cronExpression: "0 8,16 * * *" });
    assert.equal(schedule.due(at("08:00:59")).due, false, "editing cannot reuse a minute");
    assert.equal(schedule.due(at("16:00:00")).due, true);
    assert.equal(schedule.due(at("16:01:00")).due, false);
    schedule.set({ cronExpression: null });
    assert.equal(schedule.due(at("16:00:00")).due, false);
  } finally {
    cleanup();
  }
});

test("cron lists/ranges/steps, DOM/DOW OR semantics, timezones and DST wall-clock matching", () => {
  const { store, cleanup } = tempStore();
  try {
    const schedule = new Schedule({ store, cronSchedule: "* * * * *" });
    const due = (iso: string) => schedule.due(Date.parse(iso)).due;
    schedule.set({ cronExpression: "5,20-40/10 9-17/2 * * MON-FRI", timezone: "Asia/Hong_Kong" });
    assert.equal(due("2026-10-29T01:30:59Z"), true);
    assert.equal(due("2026-10-29T02:30:00Z"), false);
    assert.equal(due("2026-10-31T01:30:00Z"), false);
    schedule.set({ cronExpression: "0 9 1 * MON", timezone: "UTC" });
    assert.equal(due("2026-10-01T09:00:00Z"), true, "first of month, not Monday");
    assert.equal(due("2026-10-05T09:00:00Z"), true, "Monday, not first");
    assert.equal(due("2026-10-06T09:00:00Z"), false);
    schedule.set({ cronExpression: "30 2 * * *", timezone: "America/New_York" });
    assert.equal(due("2026-03-07T07:30:00Z"), true);
    assert.equal(due("2026-03-08T07:30:00Z"), false, "missing 02:30 is not caught up at 03:30");
    assert.equal(
      schedule.nextScheduled(Date.parse("2026-03-08T06:00:00Z"))!.toISOString(),
      "2026-03-09T06:30:00.000Z",
    );
    schedule.set({ cronExpression: "30 1 * * *" });
    assert.equal(due("2026-11-01T05:30:00Z"), true);
    assert.equal(
      due("2026-11-01T06:30:00Z"),
      true,
      "repeated wall minutes are distinct absolute slots",
    );
    assert.equal(
      schedule.nextScheduled(Date.parse("2026-11-01T05:30:00Z"))!.toISOString(),
      "2026-11-01T06:30:00.000Z",
    );
    schedule.set({ cronExpression: "0 9 * JAN,MAR THU", timezone: "UTC" });
    assert.equal(due("2026-01-01T09:00:00Z"), true);
    assert.equal(due("2026-02-05T09:00:00Z"), false);
  } finally {
    cleanup();
  }
});

test("invalid changes reject atomically, legacy presets convert, and heartbeat is process-local", () => {
  const { store, cleanup } = tempStore();
  try {
    const deps = { store, cronSchedule: "* * * * *", sweepTimezone: "UTC" };
    const schedule = new Schedule(deps);
    const saved = () => store.settings.get("schedule", {});
    const before = saved();
    for (const patch of [
      { cronExpression: "@daily" },
      { cronExpression: "0 0 */8 * * *" },
      { cronExpression: "60 * * * *" },
      { cronExpression: "* * * * *", timezone: "Not/AZone" },
      { cronExpression: "* * * * *", everyMinutes: 5 },
      { timezone: "+08:00" },
      { cronExpression: "* * * * *", cardsPerSweep: 31 },
      { everyMinutes: 7 },
      { cronExpression: "" },
      { cronExpression: "H * * * *" },
      { cronExpression: "HH * * * *" },
      { cronExpression: "H,5 * * * *" },
      { cronExpression: "H(0-15)/5 * * * *" },
      { cronExpression: "0 H/3 * * *" },
    ]) {
      assert.throws(() => schedule.set(patch));
      assert.deepEqual(saved(), before);
    }
    schedule.set({ everyMinutes: 15 });
    assert.equal(schedule.state().cronExpression, "*/15 * * * *");
    const now = Date.parse("2026-10-29T08:01:00Z");
    assert.equal(schedule.state(now).schedulerStatus, "waiting");
    assert.ok(schedule.state(now).nextScheduledAt);
    assert.equal(schedule.state(now).nextSweepAt, undefined);
    schedule.recordTick(now);
    assert.equal(schedule.state(now + 90_000).schedulerStatus, "running");
    assert.ok(schedule.state(now).nextSweepAt);
    assert.equal(schedule.state(now + 90_001).schedulerStatus, "stale");
    assert.equal(schedule.state(now + 90_001).nextSweepAt, undefined);
    assert.equal(schedule.next(now + 90_001), undefined);
    assert.equal(new Schedule(deps).state(now).schedulerStatus, "waiting");
  } finally {
    cleanup();
  }
});

test("a sweep whose agent run already ended is closed at once instead of skipping every tick", async () => {
  const { closeStalledSweeps } = await import("../src/news/sweep.ts");
  const { Bus } = await import("../src/events.ts");
  const { store, cleanup } = tempStore();
  try {
    const open = store.sweeps.create({ requestId: "c-open", trigger: "cron", status: "running" });
    const fresh = store.sweeps.create({ requestId: "c-fresh", trigger: "cron", status: "running" });
    store.sweeps.update(open.id, { submissionId: 10 });
    store.sweeps.update(fresh.id, { submissionId: 20 });
    const run = store.db.prepare(
      "INSERT INTO agent_runs (run_entry_id, conversation_id, submission_id, sweep_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    run.run(1, 1, 10, open.id, "unanswered", Date.now() - 60_000, Date.now() - 30_000);
    // Between tool calls a run has ended_at stamped but is still running.
    run.run(2, 1, 20, fresh.id, "running", Date.now() - 60_000, Date.now() - 30_000);
    // Its researcher subagent finished: a done run with the same sweep id that is not the sweep's own run.
    run.run(3, 7, 30, fresh.id, "done", Date.now() - 50_000, Date.now() - 40_000);
    const log = {
      info() {},
      warn() {},
      error() {},
      debug() {},
      child() {
        return log;
      },
    } as any;
    closeStalledSweeps({ store, log, bus: new Bus(), config: { stallMinutes: 30 } as any });
    assert.equal(store.sweeps.get(open.id)!.status, "stalled");
    assert.match(
      store.sweeps.get(open.id)!.error!,
      /run ended \(unanswered\) before complete_sweep/,
    );
    assert.equal(store.sweeps.get(fresh.id)!.status, "running", "a sweep still at work stays open");
  } finally {
    cleanup();
  }
});

test("a sweep queued behind a failed run is withdrawn from the inbox and closed, so the next tick can start", async () => {
  const { withdrawStuckSweeps } = await import("../src/news/sweep.ts");
  const { Bus } = await import("../src/events.ts");
  const { store, cleanup } = tempStore();
  try {
    const failed = Date.now() + 1_000;
    const queued = store.sweeps.create({ requestId: "q-1", trigger: "cron", status: "queued" });
    store.sweeps.update(queued.id, { submissionId: 40 });
    const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as any;
    const withdrawn: number[] = [];
    const queue = {
      mainId: 1,
      withdraw: async (id: number) => (withdrawn.push(id), "aborted"),
    };
    const run = store.db.prepare(
      "INSERT INTO agent_runs (run_entry_id, conversation_id, submission_id, status, started_at, ended_at) VALUES (?, 1, ?, ?, ?, ?)",
    );
    run.run(1, 30, "running", Date.now() - 60_000, Date.now());
    await withdrawStuckSweeps({ store, log, bus: new Bus() }, queue);
    assert.equal(store.sweeps.get(queued.id)!.status, "queued", "behind a working run it waits");
    store.db.prepare("UPDATE agent_runs SET status = 'unanswered', ended_at = ?").run(failed);
    await withdrawStuckSweeps({ store, log, bus: new Bus() }, queue);
    assert.deepEqual(withdrawn, [40]);
    assert.equal(store.sweeps.get(queued.id)!.status, "stalled");
    assert.match(store.sweeps.get(queued.id)!.error!, /failed, so it was withdrawn/);
  } finally {
    cleanup();
  }
});
