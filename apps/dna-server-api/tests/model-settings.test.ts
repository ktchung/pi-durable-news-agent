import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { DnaClient, DnaError, type AgentConfigBody, type ModelInfo } from "@dna/sdk";
import { newToken } from "@dna/sdk/node";
import { createHttpApp } from "../src/app.ts";
import { deepResearchSetting } from "../src/news/deep-research.ts";
import { selectModel } from "../src/news/model-selection.ts";
import { openApp, type App } from "../src/runtime.ts";
import { fauxApp } from "./helpers.ts";

const balanced = "codex-fixture-balanced";
const fast = "codex-fixture-fast";
const maximum = "codex-fixture-max";
const empty = "codex-fixture-empty";
let app: App;
let client: DnaClient;
let server: Server;
let cleanup: () => Promise<void>;
let reopen: () => Promise<void>;

// Arbitrary catalog ids and exact per-model efforts, backed only by the offline faux harness.
// No Codex process, credentials, provider request, or paid model is involved.
function installCatalog(app: App) {
  const entry = (
    id: string,
    thinkingLevels: string[],
    defaultThinkingLevel?: string,
  ): ModelInfo => ({
    id,
    name: id,
    tier: "T",
    icon: "lab.png",
    provider: "codex",
    contextWindow: 1_000_000,
    reasoning: true,
    cost: { input: 0, output: 0 },
    thinkingLevels,
    defaultThinkingLevel,
  });
  const entries = [
    entry(balanced, ["low", "high", "xhigh"], "high"),
    entry(fast, ["minimal", "low"], "minimal"),
    entry(maximum, ["max"]),
    entry(empty, [], "high"),
  ];
  Object.assign(app.catalog, {
    provider: "codex",
    defaultModel: { provider: "faux", modelId: balanced },
    list: () => entries,
    info: (id: string) => entries.find((m) => m.id === id),
    ref: (id: string) => {
      assert.ok(
        entries.some((m) => m.id === id),
        `fixture ref ${id} must be in the catalog`,
      );
      return { provider: "faux", modelId: id };
    },
  });
}

async function listen() {
  server = createHttpApp(app).http.listen(0, "127.0.0.1");
  await once(server, "listening");
  client = new DnaClient(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    app.config.clientToken,
  );
}

const closeServer = () =>
  new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
const fails = (body: AgentConfigBody, field: RegExp) =>
  assert.rejects(
    client.configure(body),
    (e: unknown) => e instanceof DnaError && e.status === 400 && field.test(e.message),
  );
const selection = (state: Awaited<ReturnType<DnaClient["agent"]>>) => ({
  model: state.model,
  thinkingLevel: state.thinkingLevel,
  quick: state.quick,
  deepResearch: state.deepResearch,
});

before(async () => {
  const fixture = await fauxApp({
    DNA_CLIENT_TOKEN: newToken(),
    DNA_CRON_TOKEN: newToken(),
    FIRECRAWL_API_KEY: "",
  });
  app = fixture.app;
  installCatalog(app);
  await listen();
  cleanup = async () => {
    await closeServer();
    await app.close();
    await fixture.cleanup();
  };
  reopen = async () => {
    await closeServer();
    await app.close();
    app = await openApp(fixture.config);
    installCatalog(app);
    await listen();
  };
});
after(async () => cleanup?.());

test("Codex defaults and all model-only changes use each model's returned efforts", async () => {
  let forced: boolean | undefined;
  app.catalog.refresh = async (force) => {
    forced = force;
  };
  app.catalog.catalogState = () => ({
    source: "codex",
    stale: false,
    refreshedAt: "2026-01-01T00:00:00Z",
  });
  const info = await client.info(true);
  assert.equal(forced, true, "manual picker refresh reaches the server catalog");
  assert.equal(info.modelCatalog?.source, "codex");
  assert.deepEqual(info.models.find((entry) => entry.id === balanced)?.thinkingLevels, [
    "low",
    "high",
    "xhigh",
  ]);
  delete app.catalog.refresh;
  delete app.catalog.catalogState;
  const storedDefaults = app.store.db.prepare("SELECT * FROM settings ORDER BY key").all();
  const initial = await client.agent();
  assert.deepEqual(initial.quick, { model: balanced, thinkingLevel: "high" });
  assert.deepEqual(initial.deepResearch, { model: balanced, thinkingLevel: "high", count: 1 });
  assert.equal(app.agents.researcher().model?.modelId, balanced);
  assert.equal(app.agents.researcher().thinkingLevel, "high");
  assert.deepEqual(
    app.store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
    storedDefaults,
    "reading defaults does not write settings",
  );

  await client.configure({
    model: balanced,
    thinkingLevel: "xhigh",
    quickThinking: "xhigh",
    deepResearchThinking: "xhigh",
  });
  const changed = await client.configure({
    model: fast,
    quickModel: fast,
    deepResearchModel: fast,
  });
  assert.equal(changed.thinkingLevel, "minimal");
  assert.equal(changed.quick.thinkingLevel, "minimal");
  assert.equal(changed.deepResearch.thinkingLevel, "minimal");
  await client.configure({
    thinkingLevel: "low",
    quickThinking: "low",
    deepResearchThinking: "low",
  });
  const preserved = await client.configure({
    model: balanced,
    quickModel: balanced,
    deepResearchModel: balanced,
  });
  assert.equal(preserved.thinkingLevel, "low");
  assert.equal(preserved.quick.thinkingLevel, "low");
  assert.equal(preserved.deepResearch.thinkingLevel, "low");

  const max = await client.configure({
    model: maximum,
    quickModel: maximum,
    deepResearchModel: maximum,
  });
  assert.equal(max.thinkingLevel, "max", "without a default, use the first returned effort");
  assert.equal(max.quick.thinkingLevel, "max");
  assert.equal(max.deepResearch.thinkingLevel, "max");
  await client.configure({
    thinkingLevel: "max",
    quickThinking: "max",
    deepResearchThinking: "max",
  });
  for (const child of [app.agents.researcher(), app.agents.deepResearcher()]) {
    assert.equal(
      child.model?.modelId,
      maximum,
      "sweep and deep research follow the same live UI setting",
    );
    assert.equal(child.thinkingLevel, "max");
  }
});

test("unsupported effort, unknown model and mixed invalid requests are 400 without partial writes", async () => {
  const before = selection(await client.agent());
  const stored = app.store.db.prepare("SELECT * FROM settings ORDER BY key").all();
  const invalid: [AgentConfigBody, RegExp][] = [
    [{ model: balanced, thinkingLevel: "off" }, /thinkingLevel/],
    [{ quickThinking: "off" }, /quickThinking/],
    [{ deepResearchThinking: "low" }, /deepResearchThinking/],
    [{ model: "not-returned-by-catalog" }, /Unknown model/],
    [{ deepResearchModel: "not-returned-by-catalog" }, /Unknown model/],
    [{ quickModel: "not-returned-by-catalog" }, /Unknown model/],
    [{ thinkingLevel: " max " as never }, /thinkingLevel/],
    [{ model: empty }, /no supported thinking levels/],
    [
      {
        model: balanced,
        thinkingLevel: "high",
        quickModel: fast,
        deepResearchModel: balanced,
        deepResearchThinking: "max",
        deepResearchCount: 3,
      },
      /deepResearchThinking/,
    ],
    [
      { model: balanced, quickModel: fast, quickThinking: "high", deepResearchCount: 2 },
      /quickThinking/,
    ],
    [{ quickModel: fast, deepResearchModel: balanced, deepResearchCount: 0 }, /deepResearchCount/],
  ];
  for (const [body, field] of invalid) {
    await fails(body, field);
    assert.deepEqual(selection(await client.agent()), before);
    assert.deepEqual(
      app.store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
      stored,
      "no persisted setting changed",
    );
  }
  // Missing/default efforts must not invent "off" or accept an unadvertised default.
  assert.throws(
    () => selectModel(app.catalog, { model: empty }, {}),
    /no supported thinking levels/,
  );
});

test("persisted foreign root and removed models reconcile to valid selections while valid choices survive refresh", async () => {
  await app.main.configure(
    { model: { provider: "openrouter", modelId: "old-provider-fixture" }, thinkingLevel: "off" },
    app.ctx,
  );
  await client.info(true);
  let root = await app.main.agent(app.ctx);
  assert.equal(
    root.model?.provider,
    "faux",
    "uses the active fixture transport, not persisted OpenRouter",
  );
  assert.equal(root.model?.modelId, balanced);
  assert.equal(root.thinkingLevel, "high");
  await client.configure({ model: fast, thinkingLevel: "minimal" });
  await client.info(true);
  root = await app.main.agent(app.ctx);
  assert.equal(root.model?.modelId, fast);
  assert.equal(root.thinkingLevel, "minimal");
  const remaining = app.catalog.list().filter((entry) => entry.id !== fast);
  const original = { list: app.catalog.list, info: app.catalog.info };
  app.catalog.list = () => remaining;
  app.catalog.info = (id) => remaining.find((entry) => entry.id === id);
  try {
    await client.info(true);
    root = await app.main.agent(app.ctx);
    assert.equal(root.model?.modelId, balanced);
    assert.equal(root.thinkingLevel, "high");
  } finally {
    app.catalog.list = original.list;
    app.catalog.info = original.info;
  }
});

test("main, quick and research selections persist across a real SQLite/harness reopen", async () => {
  const configured = await client.configure({
    model: balanced,
    thinkingLevel: "xhigh",
    quickModel: fast,
    quickThinking: "minimal",
    deepResearchModel: maximum,
    deepResearchThinking: "max",
    deepResearchCount: 4,
  });
  await reopen();
  assert.deepEqual(selection(await client.agent()), selection(configured));
  assert.deepEqual(app.quick.setting(), configured.quick);
  assert.deepEqual(deepResearchSetting(app.store, app.catalog), configured.deepResearch);
  assert.equal(app.agents.researcher().model?.modelId, maximum);
  assert.equal(app.agents.researcher().thinkingLevel, "max");

  // A saved selection removed by a later catalog refresh falls back to its advertised default.
  app.store.settings.set("quick", { model: "removed-codex-model", thinkingLevel: "off" });
  app.store.settings.set("deepResearch", {
    model: "removed-codex-model",
    thinkingLevel: "max",
    count: 4,
  });
  const refreshed = await client.agent();
  assert.deepEqual(refreshed.quick, { model: balanced, thinkingLevel: "high" });
  assert.deepEqual(refreshed.deepResearch, { model: balanced, thinkingLevel: "high", count: 4 });
  app.store.settings.set("quick", { model: fast, thinkingLevel: "high" });
  app.store.settings.set("deepResearch", { model: fast, thinkingLevel: "max", count: 2 });
  assert.deepEqual(app.quick.setting(), { model: fast, thinkingLevel: "minimal" });
  assert.deepEqual(deepResearchSetting(app.store, app.catalog), {
    model: fast,
    thinkingLevel: "minimal",
    count: 2,
  });
});
