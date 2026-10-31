import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { configure, type Conversation } from "@earendil-works/pi-durable";
import type { Frame } from "@dna/sdk";
import type { App } from "../src/runtime.ts";
import { CHUNK_CHARS, scrapeFile } from "../src/agents/tools/hyper-fetch.ts";
import { fauxApp } from "./helpers.ts";

let app: App;
let cleanup: () => Promise<void>;
let dir: string;
let researcher: Conversation;
let itemId: number;
let n = 0;

before(async () => {
  ({ app, cleanup, dir } = await fauxApp({
    DNA_FIXTURE_SET: "news",
    FIRECRAWL_API_KEY: "fc-test",
  }));
  const doc = app.store.sources.cache({
    url: "https://example.com/durable-agents",
    title: "Durable agents survive restarts",
    excerpt: "Short excerpt.",
    contentMd: "durable ".repeat(2000),
    fetchVia: "feed",
    ttlMinutes: 60,
  });
  itemId = app.store.news.upsertItem({
    cacheId: doc.id,
    url: doc.url,
    title: doc.title!,
    sourceName: "test",
    excerpt: doc.excerpt,
  }).item.id;
  const id = await app.harness.harness.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, child.id, app.agents.researcher());
    return child.id;
  }, app.ctx);
  researcher = (await app.harness.harness.conversation(id, app.ctx))!;
});
after(() => cleanup());

test("present_news requires research for uncertain story overlap", async () => {
  const item = app.store.news.upsertItem({
    url: "https://example.com/uncertain-story",
    title: "Scion report",
  }).item;
  app.store.news.updateItem(item.id, {
    lastError: "Story relationship uncertain: research before suppressing or linking",
  });
  const result = await callTool(app.main, "present_news", {
    item_id: item.id,
    component: "brief",
    props: { title: item.title, summary: "A report." },
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /research_items/);
  assert.equal(app.store.news.cardForItem(item.id), undefined);
});

/** Drive one tool through the faux model and return the tool result it saw. */
async function callTool(conversation: Conversation, name: string, args: object) {
  const submission = await conversation.submit(
    {
      type: "input",
      content: `FAUX_CALL ${name} ${JSON.stringify(args)}`,
      requestId: `tools:${n++}`,
    },
    app.ctx,
  );
  await submission.wait(app.ctx);
  const page = await conversation.entries({ order: "descending" }, 10, undefined, app.ctx);
  const result = page.items.find((e) => e.kind === "pi.tool-result")!.model![0] as {
    isError: boolean;
    content: { text?: string }[];
  };
  return { isError: result.isError, text: result.content.map((c) => c.text ?? "").join("") };
}

test("a researcher cannot present: present_news is not one of its tools and no card is written", async () => {
  const r = await callTool(researcher, "present_news", {
    item_id: itemId,
    component: "brief",
    props: { title: "x", summary: "y" },
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /present_news/);
  assert.equal(app.store.news.cards().length, 0);
});

test("a researcher can read items and run jev", async () => {
  const r = await callTool(researcher, "jev_classify", { command: "hfs", item_id: itemId });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`^#${itemId} hfs: \\w+ \\d+, \\w+ \\d+, \\w+ \\d+`));
});

test("an unknown jev command comes back with the valid list and an example", async () => {
  const r = await callTool(app.main, "jev_classify", { command: "vibes", item_id: itemId });
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /"command" must be one of: relevance, worth-attention, hfs, same-story, claim-support, importance. You sent "vibes"/,
  );
  assert.match(r.text, /"command":"hfs"/);
});

test("jev claim-support without claims is a fixable error, not a crash", async () => {
  const r = await callTool(app.main, "jev_classify", { command: "claim-support", item_id: itemId });
  assert.equal(r.isError, true);
  assert.match(r.text, /claim-support needs claims/);
});

test("read_item caps cached text at 3000 chars by default and honors max_chars", async () => {
  const full = await callTool(app.main, "read_item", { item_id: itemId });
  assert.equal(full.isError, false);
  assert.match(full.text, /\[13000 more chars\]/);
  const short = await callTool(app.main, "read_item", { item_id: itemId, max_chars: 200 });
  assert.match(short.text, /\[15800 more chars\]/);
  const missing = await callTool(app.main, "read_item", { item_id: 99_999 });
  assert.equal(missing.isError, true);
});

test("present_timeline links presented cards in date order, extends by id, and names the fix when it can't", async () => {
  const item = (n: number, day: number) =>
    app.store.news.upsertItem({
      url: `https://example.com/timeline-${n}`,
      title: `Timeline item ${n}`,
      sourceName: "test",
      publishedAt: `2026-10-0${day}T00:00:00.000Z`,
    }).item.id;
  const [late, early, third] = [item(1, 5), item(2, 3), item(3, 7)];
  const unpresented = await callTool(app.main, "present_timeline", {
    item_ids: [late, early],
    title: "Agents go always on",
  });
  assert.equal(unpresented.isError, true);
  assert.match(unpresented.text, /has no news card yet|have no news card yet/);
  assert.match(unpresented.text, /present_news for each item first/);
  for (const id of [late, early, third])
    await callTool(app.main, "present_news", {
      item_id: id,
      component: "brief",
      props: { title: `Item ${id}`, summary: "s" },
    });
  const untitled = await callTool(app.main, "present_timeline", { item_ids: [late, early] });
  assert.equal(untitled.isError, true);
  assert.match(untitled.text, /needs a title/);
  const linked = await callTool(app.main, "present_timeline", {
    item_ids: [late, early],
    title: "Agents go always on",
  });
  assert.equal(linked.isError, false, linked.text);
  const id = Number(linked.text.match(/Timeline (\d+)/)![1]);
  assert.match(linked.text, new RegExp(`#${early} 1/2, #${late} 2/2`), "ordered by publish date");
  const extended = await callTool(app.main, "present_timeline", {
    item_ids: [third],
    timeline_id: id,
  });
  assert.match(extended.text, new RegExp(`#${early} 1/3, #${late} 2/3, #${third} 3/3`));
  const cards = app.store.news.timelineCards(id);
  assert.deepEqual(
    cards.map((c) => c.timeline!.index),
    [1, 2, 3],
  );
  assert.equal(app.store.news.timelines()[0].title, "Agents go always on");
});

test("present_timeline merges items the story classifier already placed in separate stories", async () => {
  const { news } = app.store;
  const item = (n: number, day: number) =>
    news.upsertItem({
      url: `https://example.com/merge-${n}`,
      title: `Release story ${n}`,
      sourceName: "test",
      publishedAt: `2026-10-0${day}T00:00:00.000Z`,
    }).item;
  const [a, b] = [item(1, 2), item(2, 4)];
  for (const it of [a, b]) {
    news.ensureStory(it); // what the sweep's dedupe phase does for every new story
    await callTool(app.main, "present_news", {
      item_id: it.id,
      component: "brief",
      props: { title: it.title, summary: "s" },
    });
  }
  assert.notEqual(news.membership(a.id)!.storyId, news.membership(b.id)!.storyId);
  const linked = await callTool(app.main, "present_timeline", {
    item_ids: [b.id, a.id],
    title: "One release, two reports",
  });
  assert.equal(linked.isError, false, linked.text);
  assert.match(linked.text, new RegExp(`#${a.id} 1/2, #${b.id} 2/2`));
  assert.equal(news.membership(a.id)!.storyId, news.membership(b.id)!.storyId);
  const again = await callTool(app.main, "present_timeline", { item_ids: [a.id, b.id] });
  assert.equal(again.isError, false, "a replayed or repeated link is harmless");
  const feed = news.cards({ limit: 500 }).filter((c) => [a.id, b.id].includes(c.itemId!));
  assert.deepEqual(
    feed.map((c) => c.itemId),
    [b.id],
    "the feed shows the newest card of the story",
  );
});

test("save_source saves a site the agent found, refuses aggregators, and does not save twice", async () => {
  const hn = await callTool(app.main, "save_source", {
    url: "https://news.ycombinator.com/item?id=1",
    reason: "A good thread",
  });
  assert.equal(hn.isError, true);
  assert.match(hn.text, /searched every sweep already/);
  const skip = await callTool(app.main, "save_source", { skip: true, reason: "not news" });
  assert.equal(skip.isError, true);
  assert.match(skip.text, /skip needs a lead_id/);
  const saved = await callTool(app.main, "save_source", {
    url: "https://durable.example.dev/blog",
    reason: "Publishes durable agent releases every week.",
  });
  assert.equal(saved.isError, false, saved.text);
  assert.match(saved.text, /Saved source #\d+ Fixture Weblog \(atom, \d+ entries now\)/);
  const source = app.store.sources.list().find((s) => s.url.includes("durable.example.dev"))!;
  assert.equal(source.origin, "agent");
  assert.equal(source.reason, "Publishes durable agent releases every week.");
  const twice = await callTool(app.main, "save_source", {
    url: "https://durable.example.dev/other",
    reason: "again",
  });
  assert.match(twice.text, new RegExp(`Already a source: #${source.id}`));
});

test("reader tools vote, label, edit keywords, open tabs and highlight cards the way the browser does", async () => {
  const frames: Frame[] = [];
  const stop = app.bus.subscribe((f) => frames.push(f));
  try {
    const topic = app.store.taste.addKeyword("topic", "durable queues");
    const itemId = app.store.news.upsertItem({
      url: "https://queues.example.dev/posts/durable-queues-1",
      title: "Durable queues ship for agents",
      sourceName: "queues.example.dev",
      excerpt: "A durable queues release.",
      publishedAt: "2026-10-04T00:00:00.000Z",
    }).item.id;
    app.store.news.updateItem(itemId, { matchedTopic: "durable queues" });
    await callTool(app.main, "present_news", {
      item_id: itemId,
      component: "brief",
      props: { title: "Durable queues ship for agents", summary: "s" },
    });
    const card = app.store.news.cardForItem(itemId)!;

    const down = await callTool(app.main, "card_feedback", { item_id: itemId, vote: "down" });
    assert.equal(down.isError, false, down.text);
    assert.match(down.text, new RegExp(`card ${card.id} .*voted down`));
    assert.match(down.text, /durable queues 1\.00 to 0\.85/);
    assert.equal(app.store.news.card(card.id)!.feedback?.signal, "less");
    assert.ok(frames.some((f) => f.type === "feed.card_updated" && f.card.id === card.id));
    assert.ok(frames.some((f) => f.type === "taste.keywords"));
    const labeled = await callTool(app.main, "card_feedback", {
      card_id: card.id,
      labels: ["signal", "facts"],
    });
    assert.match(labeled.text, /labeled signal, facts/);
    const bad = await callTool(app.main, "card_feedback", { card_id: card.id, vote: "sideways" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /must be one of: up, down/);

    const up = await callTool(app.main, "edit_keyword", {
      action: "rank_up",
      term: "durable queues",
    });
    assert.match(up.text, /Ranked up: .*weight 0\.95 \(was 0\.85\)/);
    const off = await callTool(app.main, "edit_keyword", {
      action: "disable",
      keyword_id: topic.id,
    });
    assert.match(off.text, /Disabled .*\(off\)/);
    assert.equal(app.store.taste.keyword(topic.id)!.enabled, false);
    const added = await callTool(app.main, "edit_keyword", {
      action: "add",
      kind: "signal",
      term: "migration guide",
    });
    assert.match(added.text, /Added #\d+ signal "migration guide" weight 1\.00/);
    const removed = await callTool(app.main, "edit_keyword", {
      action: "remove",
      term: "migration guide",
    });
    assert.match(removed.text, /Removed/);
    assert.equal(app.store.taste.findKeyword("signal", "migration guide"), undefined);
    const missing = await callTool(app.main, "edit_keyword", { action: "remove", term: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /read_taste/);
    const boostNew = await callTool(app.main, "edit_keyword", {
      action: "rank_up",
      term: "swarms",
    });
    assert.equal(boostNew.isError, true);
    assert.match(boostNew.text, /add it first: \{"action": "add", "term": "swarms"\}/);

    const source = app.store.sources.add({
      kind: "rss",
      name: "Queues Weekly",
      url: "https://queues.example.dev/feed.xml",
    });
    const taste = await callTool(app.main, "read_taste", {});
    assert.match(taste.text, new RegExp(`#${source.id} rss "Queues Weekly" weight 1\\.00`));
    const lowered = await callTool(app.main, "edit_source", {
      action: "rank_down",
      name: "queues weekly",
    });
    assert.equal(lowered.isError, false, lowered.text);
    assert.match(lowered.text, /Ranked down: .*"Queues Weekly" weight 0\.90 \(was 1\.00\)/);
    const raised = await callTool(app.main, "edit_source", {
      action: "rank_up",
      source_id: source.id,
    });
    assert.match(raised.text, /Ranked up: .*weight 1\.00 \(was 0\.90\)/);
    assert.equal(app.store.sources.get(source.id)!.weight, 1);
    app.store.sources.update(source.id, { weight: 2 });
    const capped = await callTool(app.main, "edit_source", {
      action: "rank_up",
      source_id: source.id,
    });
    assert.match(capped.text, /already at its 2\.00 cap/);
    const noSource = await callTool(app.main, "edit_source", { action: "rank_up", name: "nope" });
    assert.equal(noSource.isError, true);
    assert.match(noSource.text, /read_taste/);

    for (const [by, value] of [
      ["search", "queues SHIP"],
      ["keyword", "durable queues"],
      ["url", "https://www.queues.example.dev/"],
    ]) {
      const tab = await callTool(app.main, "open_tab", { by, value });
      assert.equal(tab.isError, false, tab.text);
      assert.match(tab.text, new RegExp(`Opened the ${by} tab .*: 1 news card\\.`));
      assert.match(tab.text, new RegExp(`card ${card.id} "Durable queues ship for agents"`));
      assert.ok(frames.some((f) => f.type === "ui.open_tab" && f.by === by && f.value === value));
    }
    const none = await callTool(app.main, "open_tab", { by: "search", value: "queues zebra" });
    assert.match(none.text, /no news cards match yet/);

    const lit = await callTool(app.main, "highlight_item", { card_id: card.id });
    assert.match(lit.text, new RegExp(`Highlighted card ${card.id}`));
    assert.ok(frames.some((f) => f.type === "ui.highlight" && f.card.id === card.id));
    const nothing = await callTool(app.main, "highlight_item", { card_id: 999999 });
    assert.equal(nothing.isError, true);
  } finally {
    stop();
  }
});

test("present_news dates an undated item from its page before the card goes out", async () => {
  const id = app.store.news.upsertItem({
    url: "https://undated.example.dev/2026/10/09/launch-notes",
    title: "Launch notes without a feed date",
    sourceName: "undated.example.dev",
  }).item.id;
  const r = await callTool(app.main, "present_news", {
    item_id: id,
    component: "brief",
    props: { title: "Launch notes", summary: "s" },
  });
  assert.equal(r.isError, false, r.text);
  const item = app.store.news.item(id)!;
  assert.ok(item.publishedAt && item.dateSource === "meta", "the fixture page states its time");
  assert.equal(app.store.news.cardForItem(id)!.publishedAt, item.publishedAt);
});

test("set_schedule changes how often sweeps run and refuses intervals the tick cannot keep", async () => {
  const frames: Frame[] = [];
  const stop = app.bus.subscribe((f) => frames.push(f));
  try {
    const set = await callTool(app.main, "set_schedule", { every: "30" });
    assert.match(set.text, /Sweeps run every 30 minutes/);
    assert.equal(app.schedule.every(), 30);
    assert.ok(frames.some((f) => f.type === "schedule" && f.schedule.everyMinutes === 30));
    const off = await callTool(app.main, "set_schedule", { every: "off" });
    assert.match(off.text, /off/);
    assert.equal(app.schedule.every(), null);
    const cards = await callTool(app.main, "set_schedule", { cards: 12 });
    assert.match(cards.text, /at most 12 cards/);
    assert.equal(app.schedule.cards(), 12);
    app.schedule.set({ cronExpression: "0 9 * * MON-FRI", timezone: "UTC" });
    const custom = await callTool(app.main, "set_schedule", { cards: 11 });
    assert.match(custom.text, /Sweeps follow cron 0 9 \* \* MON-FRI/);
    assert.doesNotMatch(custom.text, /sweeps are off/i);
    await callTool(app.main, "set_schedule", { cards: 7 });
    const bad = await callTool(app.main, "set_schedule", { every: "7" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /must be one of: 1, 5, 10, 15, 30, 60, off/);
    await callTool(app.main, "set_schedule", { every: "5" });
  } finally {
    stop();
  }
});

test("hyper_fetch: with a Firecrawl key the desk scrapes an article in full; a researcher has no such tool", async () => {
  assert.ok(app.agents.tools["news-desk"].some((t) => t.name === "hyper_fetch"));
  assert.ok(!app.agents.tools["news-researcher"].some((t) => t.name === "hyper_fetch"));
  const url = "https://exe.dev/blog/persistent-sandboxes";
  const r = await callTool(app.main, "hyper_fetch", { url });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /via firecrawl, 1 credits\), chunk 1 of 1/);
  assert.match(r.text, /migration guide/);
  assert.match(r.text, /End of article\./);
  const again = await callTool(app.main, "hyper_fetch", { url });
  assert.match(
    again.text,
    /via saved copy/,
    "a second call reads the saved file, no second scrape",
  );
  const blocked = await callTool(researcher, "hyper_fetch", { url });
  assert.equal(blocked.isError, true);
});

test("hyper_fetch reads a long saved scrape chunk by chunk to the end", async () => {
  const url = "https://example.com/long-article";
  const file = scrapeFile(dir, url);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "a".repeat(CHUNK_CHARS) + "b".repeat(CHUNK_CHARS) + "tail of the article");
  const first = await callTool(app.main, "hyper_fetch", { url });
  assert.match(first.text, /chunk 1 of 3/);
  assert.match(first.text, /call hyper_fetch with chunk 2, and keep going to chunk 3/);
  assert.ok(!first.text.includes("bbbb"), "chunk 1 stops where chunk 2 starts");
  const last = await callTool(app.main, "hyper_fetch", { url, chunk: 3 });
  assert.match(last.text, /chunk 3 of 3[^]*tail of the article\nEnd of article\./);
  const past = await callTool(app.main, "hyper_fetch", { url, chunk: 4 });
  assert.equal(past.isError, true);
  assert.match(past.text, /has 3 chunks/);
});
