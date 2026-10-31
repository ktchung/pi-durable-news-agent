// The durable agents as pi-durable extensions: news-desk (root, runs sweeps), news-researcher (sweep research
// subagents) and deep-research (subagents of a deep dive the reader asked for).
import { join } from "node:path";
import {
  defineExtension,
  section,
  type AgentChange,
  type Extension,
} from "@earendil-works/pi-durable";
import { allowOnly, loadPrompt, observability } from "@dna/durable-agent";
import type { Deps } from "../deps.ts";
import { componentCatalog } from "../news/components.ts";
import { createDeepResearchTask, deepResearchSetting } from "../news/deep-research.ts";
import { createImageTask } from "../news/image-task.ts";
import { createSweepTask } from "../news/sweep-task.ts";
import { askTaste } from "./tools/ask-taste.ts";
import { completeSweep } from "./tools/complete-sweep.ts";
import { deepDiveResearch } from "./tools/deep-dive-research.ts";
import { deepSearch, openPage } from "./tools/deep-web.ts";
import { hyperFetch } from "./tools/hyper-fetch.ts";
import { jevClassify } from "./tools/jev-classify.ts";
import { listCandidates } from "./tools/list-candidates.ts";
import { presentNews, presentTimeline } from "./tools/present.ts";
import { readItem } from "./tools/read-item.ts";
import {
  cardFeedback,
  editKeyword,
  editSource,
  highlightItem,
  openTab,
  setSchedule,
} from "./tools/reader.ts";
import { readTaste } from "./tools/read-taste.ts";
import { reportFindings } from "./tools/report-findings.ts";
import { researchItems } from "./tools/research-items.ts";
import { runNewsSweep } from "./tools/run-news-sweep.ts";
import { saveSource } from "./tools/save-source.ts";
import { scrapeUrl } from "./tools/scrape-url.ts";
import { searchWeb } from "./tools/search-web.ts";

export const DESK_TOOLS = [
  "run_news_sweep",
  "list_candidates",
  "read_item",
  "search_web",
  "scrape_url",
  "hyper_fetch",
  "research_items",
  "jev_classify",
  "present_news",
  "present_timeline",
  "ask_taste",
  "read_taste",
  "save_source",
  "card_feedback",
  "edit_keyword",
  "edit_source",
  "deep_dive_research",
  "open_tab",
  "highlight_item",
  "set_schedule",
  "complete_sweep",
] as const;
export const RESEARCHER_TOOLS = [
  "read_item",
  "scrape_url",
  "search_web",
  "jev_classify",
  "report_findings",
] as const;
export const DEEP_RESEARCH_TOOLS = ["deep_search", "open_page", "read_item"] as const;

export interface Agents {
  newsDesk: Extension;
  newsResearcher: Extension;
  deepResearch: Extension;
  observe: Extension;
  /** Install order for the registry. */
  all: Extension[];
  /** Default selection: the root conversation runs the desk. */
  defaults: Extension[];
  /** What a research child runs with. */
  researcher(): AgentChange;
  /** What a deep-research child runs with: the reader's deep research model and thinking level. */
  deepResearcher(): AgentChange;
  /** Each agent's tools, for the tool list clients show. */
  tools: Record<string, readonly { name: string; description: string; parameters: unknown }[]>;
}

export function createAgents(deps: Deps): Agents {
  const agentsDir = join(deps.config.promptsDir, "agents");
  const sweepTask = createSweepTask(deps);
  const imageTask = createImageTask(deps);
  const deepResearchTask = createDeepResearchTask(deps);
  const observe = observability({
    event: (e) => {
      deps.store.telemetry.event(e);
      deps.log[e.level === "debug" ? "debug" : e.level](`agent.${e.event}`, {
        conversationId: e.conversationId,
        taskId: e.taskId,
        ...e.data,
      });
    },
  });
  const deskPrompt = loadPrompt(agentsDir, "news-desk", "SYSTEM_PROMPT.md", {
    device_name: deps.config.device,
    search_mode: deps.search.mode,
    component_catalog: componentCatalog(),
  });
  const researcherPrompt = loadPrompt(agentsDir, "news-researcher", "SYSTEM_PROMPT.md", {});
  const deepResearchPrompt = loadPrompt(agentsDir, "deep-research", "SYSTEM_PROMPT.md", {
    web_access:
      deps.search.hyperFetchVia === "firecrawl"
        ? "Firecrawl (web and news search, full page scrapes), with free search engines and direct page fetches when it fails"
        : "free search engines (Bing web, DuckDuckGo, Bing News, Google News, Hacker News) and direct page fetches",
  });
  const shared = {
    readItem: readItem(deps),
    searchWeb: searchWeb(deps),
    scrapeUrl: scrapeUrl(deps),
    jevClassify: jevClassify(deps),
  };

  const researcherTools = [
    shared.readItem,
    shared.scrapeUrl,
    shared.searchWeb,
    shared.jevClassify,
    reportFindings(deps),
  ];
  const newsResearcher = defineExtension({
    name: "news-researcher",
    tools: researcherTools,
    sections: [section("news-researcher", () => researcherPrompt, { tag: false })],
    hooks: [allowOnly("news-researcher", RESEARCHER_TOOLS)],
  });
  const researcher = (): AgentChange => {
    const setting =
      deps.catalog.provider === "codex"
        ? deepResearchSetting(deps.store, deps.catalog)
        : { model: deps.config.researchModel, thinkingLevel: "low" as const };
    return {
      model:
        deps.catalog.provider === "faux"
          ? deps.catalog.defaultModel
          : deps.catalog.ref(setting.model),
      thinkingLevel: setting.thinkingLevel,
      extensions: [newsResearcher, observe],
    };
  };
  const deepResearchTools = [deepSearch(deps), openPage(deps), shared.readItem];
  const deepResearch = defineExtension({
    name: "deep-research",
    tools: deepResearchTools,
    sections: [section("deep-research", () => deepResearchPrompt, { tag: false })],
    hooks: [allowOnly("deep-research", DEEP_RESEARCH_TOOLS)],
  });
  const deepResearcher = (): AgentChange => {
    const setting = deepResearchSetting(deps.store, deps.catalog);
    return {
      model:
        deps.catalog.provider === "faux"
          ? deps.catalog.defaultModel
          : deps.catalog.ref(setting.model),
      thinkingLevel: setting.thinkingLevel,
      extensions: [deepResearch, observe],
    };
  };
  const deskTools = [
    runNewsSweep(deps, sweepTask),
    listCandidates(deps),
    shared.readItem,
    shared.searchWeb,
    shared.scrapeUrl,
    hyperFetch(deps),
    researchItems(deps, researcher),
    shared.jevClassify,
    presentNews(deps, imageTask),
    presentTimeline(deps),
    askTaste(deps),
    readTaste(deps),
    saveSource(deps),
    cardFeedback(deps),
    editKeyword(deps),
    editSource(deps),
    deepDiveResearch(deps, deepResearchTask, deepResearcher),
    openTab(deps),
    highlightItem(deps),
    setSchedule(deps),
    completeSweep(deps),
  ];
  const newsDesk = defineExtension({
    name: "news-desk",
    tools: deskTools,
    sections: [section("news-desk", () => deskPrompt, { tag: false })],
    hooks: [allowOnly("news-desk", DESK_TOOLS)],
    tasks: [sweepTask, imageTask, deepResearchTask],
  });
  return {
    newsDesk,
    newsResearcher,
    deepResearch,
    observe,
    all: [newsDesk, newsResearcher, deepResearch, observe],
    defaults: [newsDesk, observe],
    researcher,
    deepResearcher,
    tools: {
      "news-desk": deskTools,
      "news-researcher": researcherTools,
      "deep-research": deepResearchTools,
    },
  };
}
