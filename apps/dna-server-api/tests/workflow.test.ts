import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, idle, settledSweep, type Booted } from "./server.ts";

let s: Booted;
before(async () => {
  s = await bootServer({ DNA_FIXTURE_JEV_DELAY_MS: "40" });
});
after(() => s.cleanup());

test("the workflow route: replay by requestId, skip while running, and the sweep completes on faux", async () => {
  const first = await s.cron.newsSweep({ requestId: "cron:local:20261012T1600" });
  assert.equal(first.status, 202);
  assert.equal(first.data.status, "accepted");
  assert.ok(first.data.submissionId);

  const replay = await s.cron.newsSweep({ requestId: "cron:local:20261012T1600" });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotent-replay"), "true");
  assert.equal(replay.data.status, "replay");
  assert.equal(replay.data.sweep!.id, first.data.sweep!.id);

  const second = await s.cron.newsSweep({ requestId: "cron:local:20261012T1615" });
  assert.equal(second.status, 200);
  assert.equal(second.data.status, "skipped");
  assert.match(second.data.sweep!.reason!, /still running/);

  const done = await settledSweep(s.client, first.data.sweep!.id, 60_000);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.audit?.missing, []);
  assert.ok(done.toolCalls.length > 5);
  await idle(s.client);

  const sweeps = await s.client.sweeps();
  assert.deepEqual(sweeps.map((x) => x.status).sort(), ["completed", "skipped"]);
  assert.ok(sweeps.find((x) => x.status === "completed")!.cost!.jevCalls > 0);

  const feed = await s.client.feed();
  assert.equal(feed.items.filter((c) => c.kind === "news").length, 4);
  assert.ok(
    feed.items.every((c) => c.kind === "news"),
    "the feed is news cards only",
  );
  assert.equal(feed.items.filter((c) => c.timeline).length, 0, "unrelated stories stay separate");
  assert.ok(
    feed.items.every((c, i) => i === 0 || c.id > feed.items[i - 1].id),
    "oldest first",
  );
  const image = await fetch(`${s.base}/v1/images/${feed.items[0].image!.id}`, {
    headers: { authorization: `Bearer ${s.tokens.client}` },
    redirect: "manual",
  });
  assert.ok(image.status === 200 || image.status === 302, `image ${image.status}`);
  if (image.status === 200) assert.match(image.headers.get("content-type") ?? "", /^image\//);

  const later = await s.cron.newsSweep({ requestId: "cron:local:20261012T1630" });
  assert.equal(later.data.status, "accepted", "a new sweep starts once the last one finished");
  await settledSweep(s.client, later.data.sweep!.id, 60_000);
});

test("a body without requestId is 400", async () => {
  const res = await fetch(`${s.base}/v1/workflows/news-sweep`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.tokens.cron}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid");
});

test("the schedule: presets for a 1 minute tick, PATCH a preset or off, and an off schedule skips scheduled ticks", async () => {
  const start = await s.client.schedule();
  assert.equal(start.everyMinutes, 480);
  assert.equal(start.cronExpression, "0 */8 * * *");
  assert.equal(start.schedulerStatus, "waiting");
  assert.equal(start.tickMinutes, 1);
  assert.deepEqual(start.presets, [1, 5, 10, 15, 30, 60]);
  assert.ok(start.nextScheduledAt);
  assert.equal(start.nextSweepAt, undefined);
  await assert.rejects(s.client.setSchedule(7), /everyMinutes must be one of 1, 5, 10, 15, 30, 60/);
  assert.equal((await s.client.setSchedule(30)).everyMinutes, 30);
  assert.equal((await s.client.agent()).schedule.everyMinutes, 30);
  const off = await s.client.setSchedule(null);
  assert.equal(off.everyMinutes, null);
  assert.equal(off.nextSweepAt, undefined);
  assert.equal(start.cardsPerSweep, 7);
  assert.equal((await s.client.setCardsPerSweep(10)).cardsPerSweep, 10);
  await assert.rejects(s.client.setCardsPerSweep(0), /cardsPerSweep must be/);
  await assert.rejects(s.client.setCardsPerSweep(31), /cardsPerSweep must be/);
  await s.client.setCardsPerSweep(7);
  const tick = await s.cron.newsSweep({ requestId: "cron:local:tick-off", scheduled: true });
  assert.equal(tick.status, 200);
  assert.equal(tick.data.status, "not_due");
  assert.match(tick.data.reason!, /off/);
  assert.equal(tick.data.sweep, undefined);
  await s.client.setSchedule(15);
});
