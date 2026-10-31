// Open everything the server runs: dna.sqlite, the Judge, search, images, the durable Harness with both agents,
// the telemetry projector, and the root news-desk conversation. Close it all on shutdown.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, SubmissionId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { JevClient, type Decide } from "@dna/jev";
import type { CompactionState } from "@dna/sdk";
import {
  createModelCatalog,
  DEFAULT_POINTS,
  fit,
  fits,
  installScriptedFaux,
  openDurableHarness,
  startProjector,
  toPolicy,
  type CompactionPoints,
  type DurableHarness,
} from "@dna/durable-agent";
import { createLogger, type Logger } from "@dna/sdk/node";
import { createCodexCatalog } from "@dna/durable-agent/codex";
import { createAgents, type Agents } from "./agents/index.ts";
import { fauxRules } from "./agents/faux-script.ts";
import { selectModel } from "./news/model-selection.ts";
import type { Config } from "./config.ts";
import { openStore } from "./db/store.ts";
import type { Deps } from "./deps.ts";
import { Bus } from "./events.ts";
import { Dates } from "./news/dates.ts";
import { fixtureDecide, fixtureHttp } from "./news/fixtures.ts";
import { Judge } from "./news/hfs.ts";
import { liveHttp } from "./news/http.ts";
import { Images } from "./news/images.ts";
import { Quick } from "./news/quick.ts";
import { Schedule } from "./news/schedule.ts";
import { closeStalledSweeps, withdrawStuckSweeps } from "./news/sweep.ts";
import { SearchService } from "./news/search/index.ts";

export interface CompactionSetting {
  points: CompactionPoints;
  enabled: boolean;
}

export interface App extends Deps {
  harness: DurableHarness;
  ctx: Context;
  agents: Agents;
  main: Conversation;
  compaction: CompactionSetting;
  /** The main agent's model id and context window, read live. */
  mainModel(): Promise<{ id: string; window: number }>;
  /** Reconcile persisted root configuration before resume and after catalog refresh. */
  reconcileModel(): Promise<void>;
  setCompaction(next: Partial<CompactionSetting>): CompactionSetting;
  /** The points, the switch, and the main model's window the points must fit. */
  compactionState(): CompactionState;
  /** Re-read the main model's window after a model change; refit saved points that no longer fit. */
  refreshModel(): Promise<{ id: string; window: number }>;
  readonly startedAt: number;
  close(): Promise<void>;
}

function decideFor(config: Config): Decide {
  if (config.jevBackend === "fixture") return fixtureDecide();
  const client =
    config.jevBackend === "auto" ? new JevClient() : new JevClient({ provider: config.jevBackend });
  return (state, questions, opts) => client.systemOne(state, questions, opts);
}

export async function openApp(config: Config, options: { log?: Logger } = {}): Promise<App> {
  mkdirSync(config.dataDir, { recursive: true });
  const log = options.log ?? createLogger("api").child({ device: config.device });
  const store = openStore(config.dataDir, config.configDir);
  const http = config.searchMode === "fixture" ? fixtureHttp() : liveHttp(log);
  const catalog =
    config.provider === "codex"
      ? await createCodexCatalog({ authDir: config.codexAuthDir, defaultModel: config.model })
      : createModelCatalog({
          provider: config.provider,
          installFaux: (models) => installScriptedFaux(models, fauxRules()),
          defaultModel: config.provider === "faux" ? undefined : config.model,
        });
  const judge = new Judge({
    decide: decideFor(config),
    store,
    log,
    dir: join(config.promptsDir, "jev"),
  });
  const search = new SearchService(
    { http, store, log },
    {
      mode: config.searchMode,
      firecrawlKey: config.firecrawlKey,
      sweepCap: config.sweepCredits,
      dailyCap: config.dailyCredits,
    },
  );
  const images = new Images({
    store,
    http,
    log,
    dataDir: config.dataDir,
    promptsDir: config.promptsDir,
    model: config.imageModel,
    openaiKey: config.openaiKey,
    quality: config.imageQuality,
    offline: config.provider === "faux" || config.searchMode === "fixture",
  });
  const bus = new Bus();
  const quick = new Quick({ catalog, store, log });
  const dates = new Dates({ http, store, log, quick });
  const deps: Deps = {
    config,
    log,
    store,
    bus,
    judge,
    search,
    images,
    http,
    catalog,
    quick,
    dates,
    schedule: new Schedule({
      store,
      cronSchedule: config.cronSchedule,
      sweepCron: config.sweepCron,
      sweepTimezone: config.sweepTimezone,
    }),
  };
  const agents = createAgents(deps);

  const compaction: CompactionSetting = store.settings.get("compaction", {
    points: DEFAULT_POINTS,
    enabled: true,
  });
  let window = 1_000_000;
  const harness = await openDurableHarness({
    dbPath: join(config.dataDir, "agent.sqlite"),
    catalog,
    extensions: agents.all,
    defaults: agents.defaults,
    compaction: () => toPolicy(window, compaction.points, compaction.enabled),
    logger: log,
  });
  const stopProjector = startProjector(harness.harness, store.telemetry, log);
  const ctx = harness.ctx;
  const main = await harness.harness.root(ctx, {
    agent: {
      model: catalog.defaultModel,
      thinkingLevel: catalog.info(catalog.defaultModel.modelId)?.defaultThinkingLevel as
        | import("@earendil-works/pi-ai").ModelThinkingLevel
        | undefined,
    },
  });
  const mainModel = async () => {
    const agent = await main.agent(ctx);
    const id = agent.model?.modelId ?? catalog.defaultModel.modelId;
    return { id, window: catalog.info(id)?.contextWindow ?? 1_000_000 };
  };
  const reconcileModel = async () => {
    if (catalog.provider !== "codex" || !catalog.list().length) return;
    const current = await main.agent(ctx);
    const currentId = current.model?.modelId;
    const selected = selectModel(
      catalog,
      {
        model: currentId && catalog.info(currentId) ? currentId : catalog.defaultModel.modelId,
        thinkingLevel: current.thinkingLevel,
      },
      {},
    );
    const ref = catalog.ref(selected.model);
    if (
      current.model?.provider !== ref.provider ||
      currentId !== ref.modelId ||
      current.thinkingLevel !== selected.thinkingLevel
    ) {
      await main.configure({ model: ref, thinkingLevel: selected.thinkingLevel }, ctx);
      store.settings.set("model", selected.model);
      log.warn("agent.model_reconciled", {
        model: selected.model,
        thinkingLevel: selected.thinkingLevel,
      });
    }
    window = (await mainModel()).window;
    if (!fits(window, compaction.points)) {
      compaction.points = fit(window, compaction.points);
      store.settings.set("compaction", compaction);
    }
  };
  await reconcileModel();
  window = (await mainModel()).window;
  harness.harness.resume();

  const stallTimer = setInterval(() => {
    closeStalledSweeps({ store, log, config, bus });
    withdrawStuckSweeps(
      { store, log, bus },
      {
        mainId: main.id as number,
        withdraw: (id) => harness.harness.abortSubmission(id as SubmissionId, ctx, main.id),
      },
    ).catch((error) => log.warn("sweep.withdraw_failed", { error: String(error) }));
  }, 60_000);
  stallTimer.unref();

  log.info("app.opened", {
    device: config.device,
    provider: config.provider,
    model: (await mainModel()).id,
    searchMode: search.mode,
    jev: config.jevBackend,
    dataDir: config.dataDir,
    mainConversation: main.id,
  });

  return {
    ...deps,
    harness,
    ctx,
    agents,
    main,
    compaction,
    mainModel,
    reconcileModel,
    startedAt: Date.now(),
    compactionState: () => ({ ...compaction.points, enabled: compaction.enabled, window }),
    async refreshModel() {
      const model = await mainModel();
      window = model.window;
      if (!fits(window, compaction.points)) {
        const before = compaction.points;
        compaction.points = fit(window, compaction.points);
        store.settings.set("compaction", compaction);
        log.warn("agent.compaction_refit", {
          model: model.id,
          window,
          before,
          after: compaction.points,
        });
      }
      return model;
    },
    setCompaction(next) {
      if (next.points) compaction.points = next.points;
      if (next.enabled !== undefined) compaction.enabled = next.enabled;
      store.settings.set("compaction", compaction);
      log.info("agent.compaction_set", { ...compaction.points, enabled: compaction.enabled });
      return { ...compaction };
    },
    async close() {
      clearInterval(stallTimer);
      stopProjector();
      await harness.close();
      store.close();
      catalog.close?.();
      log.info("app.closed", {});
    },
  };
}
