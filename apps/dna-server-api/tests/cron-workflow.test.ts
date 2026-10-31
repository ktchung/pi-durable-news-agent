import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame } from "@dna/sdk";
import { bootServer, idle, settledSweep } from "./server.ts";
import { until } from "./helpers.ts";

// Real HTTP/auth/SSE + persisted SQLite + the real fixture-only workflow; no credentials/providers.
test("cron settings and authorized heartbeat survive HTTP replay, due checks and restart honestly", async () => {
  const s = await bootServer({
    DNA_SWEEP_CRON: "0 */8 * * *",
    DNA_SWEEP_TIMEZONE: "Asia/Hong_Kong",
    JEV_BACKEND: "fixture",
  });
  const controller = new AbortController();
  const frames: Frame[] = [];
  const reading = (async () => {
    for await (const frame of s.client.stream(controller.signal)) frames.push(frame);
  })();
  const schedules = () => frames.filter((frame) => frame.type === "schedule");
  const patch = (body: Record<string, unknown>) => s.client.call("schedule.set", { body });
  const rawTick = (token: string, body: Record<string, unknown>) =>
    fetch(`${s.base}/v1/workflows/news-sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await until(() => frames.some((frame) => frame.type === "agent.state"));
    const initial = await s.client.schedule();
    assert.equal(initial.cronExpression, "0 */8 * * *");
    assert.equal(initial.timezone, "Asia/Hong_Kong");
    assert.equal(initial.schedulerStatus, "waiting");
    assert.equal(initial.nextSweepAt, undefined);
    assert.ok(initial.nextScheduledAt);
    assert.equal((await s.client.info()).nextSweepAt, undefined);
    assert.equal((await s.client.agent()).nextSweepAt, undefined);
    assert.equal((await s.client.sweeps()).length, 0, "startup never enqueues a sweep");

    for (const body of [
      { cronExpression: "@daily", cardsPerSweep: 12 },
      { cronExpression: "0 0 8 * * *", cardsPerSweep: 12 },
      { cronExpression: "H,5 * * * *", cardsPerSweep: 12 },
      { cronExpression: "5 * * * *", timezone: "not/a-zone", cardsPerSweep: 12 },
      { cronExpression: null, everyMinutes: null },
      { lastTickAt: new Date().toISOString(), schedulerStatus: "running" },
    ]) {
      await assert.rejects(patch(body));
      assert.deepEqual(await s.client.schedule(), initial, "invalid edit writes nothing");
    }
    assert.equal(
      (await rawTick(s.tokens.client, { requestId: "untrusted", trigger: "cron", scheduled: true }))
        .status,
      403,
    );
    assert.equal((await rawTick(s.tokens.cron, { trigger: "cron", scheduled: true })).status, 400);
    assert.equal(
      (await rawTick(s.tokens.cron, { requestId: "bad-cards", scheduled: true, cards: 0 })).status,
      400,
    );
    assert.equal(
      (await s.client.schedule()).schedulerStatus,
      "waiting",
      "auth and input validation precede heartbeat",
    );

    const minute = (new Date().getUTCMinutes() + 30) % 60;
    await s.client.setSchedule({
      cronExpression: `${minute} * * * *`,
      timezone: "UTC",
      cardsPerSweep: 2,
    });
    const notDue = await s.cron.newsSweep({
      requestId: "manual-not-ticker",
      trigger: "manual",
      scheduled: true,
    });
    assert.equal(notDue.data.status, "not_due");
    assert.equal(
      (await s.client.schedule()).schedulerStatus,
      "waiting",
      "manual triggers cannot signal ticker health",
    );
    await until(() => schedules().length === 1);
    let count = schedules().length;
    const tick = await s.cron.newsSweep({
      requestId: "cron:not-due",
      trigger: "cron",
      scheduled: true,
    });
    assert.equal(tick.data.status, "not_due");
    assert.equal((await s.client.sweeps()).length, 0);
    await until(() => schedules().length === count + 1);
    const live = await s.client.schedule();
    assert.equal(live.schedulerStatus, "running");
    assert.ok(live.lastTickAt);
    assert.ok(live.nextSweepAt);

    await s.client.setCronSchedule("* * * * *", "UTC");
    const start = await s.cron.newsSweep({
      requestId: "cron:matching",
      trigger: "cron",
      scheduled: true,
    });
    assert.equal(start.status, 202);
    assert.equal(start.data.status, "accepted");
    assert.equal(start.data.sweep!.maxCards, 2);
    await settledSweep(s.client, start.data.sweep!.id, 60_000);
    await idle(s.client);
    const beforeReplay = (await s.client.schedule()).lastTickAt!;
    count = schedules().length;
    const replay = await s.cron.newsSweep({
      requestId: "cron:matching",
      trigger: "cron",
      scheduled: true,
    });
    assert.equal(replay.data.status, "replay");
    await until(() => schedules().length === count + 1);
    assert.ok(
      (await s.client.schedule()).lastTickAt! > beforeReplay,
      "known replay still records a fresh heartbeat",
    );
    const duplicate = await s.cron.newsSweep({
      requestId: "cron:duplicate",
      trigger: "cron",
      scheduled: true,
    });
    // A slow CI run may cross a minute. Persisted same-minute behavior is deterministically tested at unit level.
    if (new Date(start.data.sweep!.createdAt).getUTCMinutes() === new Date().getUTCMinutes())
      assert.equal(duplicate.data.status, "not_due");
    else if (duplicate.data.sweep) await settledSweep(s.client, duplicate.data.sweep.id, 60_000);

    controller.abort();
    await reading;
    await s.stop();
    await s.start();
    const restarted = await s.client.schedule();
    assert.equal(
      restarted.cronExpression,
      "* * * * *",
      "saved UI schedule wins over the 8h environment seed",
    );
    assert.equal(restarted.timezone, "UTC", "saved timezone wins over the environment seed");
    assert.equal(restarted.cardsPerSweep, 2);
    assert.equal(restarted.schedulerStatus, "waiting");
    assert.equal(restarted.lastTickAt, undefined);
    assert.equal(restarted.nextSweepAt, undefined);
    assert.equal((await s.client.agent()).nextSweepAt, undefined);
    assert.ok(restarted.nextScheduledAt);
    assert.equal((await s.client.info()).nextSweepAt, undefined);
    const afterRestart = await s.cron.newsSweep({
      requestId: "cron:restart-replay",
      trigger: "cron",
      scheduled: true,
    });
    if (new Date(start.data.sweep!.createdAt).getUTCMinutes() === new Date().getUTCMinutes())
      assert.equal(
        afterRestart.data.status,
        "not_due",
        "a restart cannot reuse the matching minute",
      );
    else if (afterRestart.data.sweep)
      await settledSweep(s.client, afterRestart.data.sweep.id, 60_000);
    await s.client.setSchedule(null);
    await s.stop();
    await s.start();
    assert.equal(
      (await s.client.schedule()).cronExpression,
      null,
      "off is persisted across actual API restart",
    );
  } finally {
    controller.abort();
    await reading;
    await s.cleanup();
  }
});
