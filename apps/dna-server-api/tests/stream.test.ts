import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AgentModel, FeedModel, type Frame } from "@dna/sdk";
import { bootServer, idle, settledSweep, type Booted } from "./server.ts";

let s: Booted;
before(async () => {
  s = await bootServer();
});
after(() => s.cleanup());

const comparable = (items: unknown[]) => JSON.parse(JSON.stringify(items));

test("SSE frames reduce to the same transcript as /v1/agent/transcript, and feed.card arrives for each card", async () => {
  const frames: Frame[] = [];
  const agent = new AgentModel();
  const feed = new FeedModel();
  const stop = new AbortController();
  const reading = (async () => {
    for await (const frame of s.client.stream(stop.signal)) {
      frames.push(frame);
      agent.apply(frame);
      feed.apply(frame);
    }
  })();
  const until = async (check: () => boolean, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until(() => agent.state.ready, "the snapshot");
  assert.equal(frames[0].type, "hello");
  assert.ok(frames.some((f) => f.type === "agent.state"));

  const started = await s.cron.newsSweep({ requestId: "stream:1" });
  await settledSweep(s.client, started.data.sweep!.id);
  await idle(s.client);
  const cards = (await s.client.feed()).items;
  await until(() => feed.state.news.length === cards.length, "every card frame");

  const reply = await s.client.send({ content: "What did you find?", waitMs: 20_000 });
  assert.equal(reply.status, "done");
  await idle(s.client);
  const transcript = await s.client.transcript();
  await until(
    () => !agent.state.running && agent.state.items.length === transcript.items!.length,
    "the stream to catch up",
  );
  assert.deepEqual(comparable(agent.state.items), comparable(transcript.items!));

  const cardFrames = frames.filter((f) => f.type === "feed.card");
  assert.equal(cardFrames.length, cards.length);
  assert.deepEqual(
    new Set(cardFrames.map((f) => (f as { card: { id: number } }).card.id)),
    new Set(cards.map((c) => c.id)),
  );
  assert.ok(frames.some((f) => f.type === "sweep" && f.sweep.status === "completed"));
  const tools = agent.state.items.flatMap((i) =>
    i.kind === "assistant" ? i.blocks.filter((b) => b.type === "tool") : [],
  );
  assert.ok(
    tools.some(
      (b) => b.type === "tool" && b.call.name === "present_news" && b.call.status === "error",
    ),
    "the bad component call shows as an error",
  );
  assert.ok(
    tools.filter(
      (b) => b.type === "tool" && b.call.name === "present_news" && b.call.status === "done",
    ).length >= 4,
  );
  await until(() => feed.state.agent?.busy === false, "the feed to see the agent idle", 5_000);

  stop.abort();
  await reading;
});

test("a subagent transcript streams when asked for", async () => {
  const runs = await s.client.runs({ sweepId: 1 });
  const child = runs.find((r) => r.agent === "news-researcher")!;
  assert.ok(child, "a researcher run exists");
  const stop = new AbortController();
  const model = new AgentModel(child.conversationId);
  for await (const frame of s.client.stream(stop.signal, {
    conversations: [child.conversationId],
  })) {
    model.apply(frame);
    if (model.state.ready) break;
  }
  stop.abort();
  const transcript = await s.client.transcript({ conversationId: child.conversationId });
  assert.deepEqual(comparable(model.state.items), comparable(transcript.items!));
  assert.ok(
    model.state.items.some(
      (i) =>
        i.kind === "assistant" &&
        i.blocks.some((b) => b.type === "tool" && b.call.name === "report_findings"),
    ),
  );
});
