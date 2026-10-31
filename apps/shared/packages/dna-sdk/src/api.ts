// The v1 wire contract shared by dna-server-api, the browser, the TUI, the CLI and cron.
import type { CardComponent, HfsCategory } from "./components.ts";
import type { WireAgentEvent, WireSnapshotEvent } from "./wire.ts";

export const API_VERSION = 1 as const;

export type Scope = "read" | "chat" | "feedback" | "settings" | "workflow";

export interface ApiError {
  error: { code: string; message: string };
}

export interface HfsRank {
  category: HfsCategory;
  score: number;
  confidence: number;
}

export interface HfsScores {
  hype: number;
  facts: number;
  signal: number;
  primary: HfsCategory;
  labels: HfsCategory[];
  ranked: HfsRank[];
  suspectCombo: boolean;
}

export interface CardImage {
  id: number;
  origin: "source" | "generated";
  status: "ready" | "pending" | "failed";
  url?: string;
}

/** Where a card sits in a timeline: related news about one evolving story, oldest published first. */
export interface TimelineRef {
  id: number;
  title: string;
  /** 1-based place in the timeline. */
  index: number;
  count: number;
}

export interface TimelineSummary {
  id: number;
  title: string;
  count: number;
  updatedAt: string;
}

export interface Timeline extends TimelineSummary {
  /** The timeline's news cards, oldest published first. */
  cards: Card[];
}

export interface Card {
  id: number;
  /** Always "news" in the feed; "story" only on old story cards from before timelines. */
  kind: "news" | "story";
  component: CardComponent;
  props: Record<string, unknown>;
  itemId?: number;
  storyId?: number;
  itemIds?: number[];
  /** Historical development or coverage card, retained for detail/timelines but absent from the main feed. */
  hiddenFromFeed?: boolean;
  sources?: {
    itemId: number;
    title: string;
    url: string;
    sourceName?: string;
    publishedAt?: string;
    role: "development" | "coverage" | "evidence";
    excerpt?: string;
  }[];
  title: string;
  url?: string;
  sourceName?: string;
  discussionUrl?: string;
  publishedAt?: string;
  /** The topic keyword the item matched when it was gathered. */
  topic?: string;
  timeline?: TimelineRef;
  hfs?: HfsScores;
  attention?: number;
  image?: CardImage;
  feedback?: { signal?: "more" | "less"; labels: HfsCategory[] };
  sweepId?: number;
  toolCallId: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

/** How a feed tab finds its news: every word in the text, a topic keyword, or a link or site. */
export const TAB_BYS = ["search", "keyword", "url"] as const;
export type TabBy = (typeof TAB_BYS)[number];

/** Command-line search words: "keyword agents" and "url example.com" search by that, anything else by the words. */
export function searchQuery(words: string[]): { by: TabBy; q: string } {
  const [first, ...rest] = words;
  return (first === "keyword" || first === "url") && rest.length
    ? { by: first, q: rest.join(" ") }
    : { by: "search", q: words.join(" ") };
}

export interface Keyword {
  id: number;
  kind: "topic" | HfsCategory;
  term: string;
  weight: number;
  source: "seed" | "user";
  enabled: boolean;
  lastSearchedAt?: string;
}

export type SourceKind = "rss" | "atom" | "hn_front" | "hn_search" | "github_releases" | "web_page";
/** config: the defaults file. user: added in a client. agent: saved by the agent. upvote: saved from a reader upvote. */
export type SourceOrigin = "config" | "user" | "agent" | "upvote";

export interface Source {
  id: number;
  kind: SourceKind;
  name: string;
  url: string;
  query: string;
  weight: number;
  intervalMin: number;
  enabled: boolean;
  failCount: number;
  lastStatus?: string;
  lastError?: string;
  lastFetchedAt?: string;
  origin: SourceOrigin;
  /** Why the agent saved it. */
  reason?: string;
}

/** A site a reader upvoted, waiting for the next sweep's agent to save it as a source or skip it. */
export interface SourceLead {
  id: number;
  site: string;
  url: string;
  title?: string;
  cardId?: number;
  status: "open" | "saved" | "skipped";
  note?: string;
  sourceId?: number;
}

export interface TasteQuestion {
  id: number;
  cardId?: number;
  itemId?: number;
  question: string;
  status: "open" | "answered" | "dismissed";
  answerLabels: HfsCategory[];
  createdAt: string;
  answeredAt?: string;
}

export interface TasteState {
  keywords: Keyword[];
  recent: {
    cardId: number;
    title: string;
    signal?: "more" | "less";
    labels: HfsCategory[];
    at: string;
  }[];
}

export type SweepStatus =
  | "queued"
  | "running"
  | "completed"
  | "no_news"
  | "skipped"
  | "failed"
  | "stalled";

export interface SweepAudit {
  expected: string[];
  done: string[];
  missing: string[];
}

export interface SweepPhase {
  phase: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  note?: string;
}

export interface Sweep {
  id: number;
  requestId: string;
  trigger: "cron" | "manual" | "test";
  status: SweepStatus;
  reason?: string;
  submissionId?: number;
  runEntryId?: number;
  taskId?: number;
  searchMode?: string;
  gathered: number;
  kept: number;
  duplicates: number;
  candidates: number;
  presented: number;
  /** The most cards this sweep may present: the reader's setting, or the run's own number. */
  maxCards?: number;
  summary?: string;
  firecrawlCreditsUsed: number;
  firecrawlCreditsLeft?: number;
  phases: SweepPhase[];
  audit?: SweepAudit;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  cost?: {
    modelUsd: number;
    jevUsd: number;
    imageUsd: number;
    jevCalls: number;
    tokensIn: number;
    tokensOut: number;
  };
}

/** One parameter of an agent tool, read from its JSON schema. */
export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  /** The allowed values of an enum parameter. */
  values?: string[];
}

/** An agent tool as the model sees it, plus what it returns. */
export interface ToolInfo {
  name: string;
  /** The agents that have this tool. */
  agents: string[];
  description: string;
  params: ToolParam[];
  returns?: string;
  example?: Record<string, unknown>;
  /** The full definition: name, description and the JSON schema of its parameters. */
  definition: { name: string; description: string; parameters: unknown };
}

export interface ModelInfo {
  id: string;
  name: string;
  tier: string;
  icon: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
  /** Exact reasoning efforts supported by this model in the active provider. */
  thinkingLevels?: string[];
  defaultThinkingLevel?: string;
  cost: { input: number; output: number };
}

export interface CompactionState {
  background: number;
  force: number;
  enabled: boolean;
  window: number;
}

export interface Info {
  ok: true;
  device: string;
  /** The device's name in dna-network.yaml, for display. */
  deviceName: string;
  mode: string;
  version: string;
  piDurable: string;
  searchMode: "firecrawl" | "web" | "fixture";
  models: ModelInfo[];
  modelCatalog?: { source: string; refreshedAt?: string; stale?: boolean; error?: string };
  defaultModel: string;
  cronSchedule: string;
  nextSweepAt?: string;
  firecrawl?: { creditsToday: number; dailyCap: number; sweepCap: number; creditsLeft?: number };
  /** Each search engine since the API started: answers, failures, and the cooldown after a failure. */
  search?: { engines: SearchEngineHealth[] };
}

/** One search engine (firecrawl, bing-news, google-news, hn, bing-web, duckduckgo). */
export interface SearchEngineHealth {
  name: string;
  ok: number;
  failed: number;
  /** Failures in a row. */
  streak: number;
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** Skipped until then after a failure. */
  coolingUntil?: string;
}

export interface AgentState {
  conversationId: number;
  model: string;
  thinkingLevel: string;
  /** The quick model for one-shot jobs such as reading publish dates. */
  quick: { model: string; thinkingLevel: string };
  /** The deep-research subagents deep_dive_research starts: their model, thinking level and how many. */
  deepResearch: { model: string; thinkingLevel: string; count: number };
  busy: boolean;
  contextTokens: number;
  contextWindow: number;
  compaction: CompactionState;
  usage: {
    tokens: number;
    costUsd: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Everything this device has spent, all time: model, jev and generated images. */
  spend: { modelUsd: number; jevUsd: number; imageUsd: number; totalUsd: number };
  lastActivityAt?: number;
  nextSweepAt?: string;
  /** How often scheduled sweeps run. */
  schedule: ScheduleState;
}

export interface GenerationRow {
  entryId: number;
  conversationId: number;
  runEntryId?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  contextTokens: number;
  durationMs?: number;
  thinkingChars: number;
  text?: string;
  toolCalls: number;
  startedAt: number;
  endedAt?: number;
}

export interface ToolCallRow {
  id: number;
  callId: string;
  generationEntryId: number;
  conversationId: number;
  runEntryId?: number;
  sweepId?: number;
  taskId?: number;
  toolName: string;
  args?: unknown;
  status: string;
  isError: boolean;
  resultText?: string;
  details?: unknown;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  toolCostUsd: number;
  /** jev and generated image cost this call paid for. */
  paidUsd?: number;
  contextTokens?: number;
  children?: number[];
}

export interface JevCallRow {
  id: number;
  command?: string;
  version?: number;
  model?: string;
  questions: number;
  answers?: unknown;
  inputTokens?: number;
  costUsd?: number;
  costSource?: string;
  elapsedMs?: number;
  attempts?: number;
  error?: string;
  itemId?: number;
  sweepId?: number;
  callId?: string;
  createdAt: string;
}

export interface FirecrawlCallRow {
  id: number;
  endpoint: string;
  query?: string;
  url?: string;
  status: string;
  results?: number;
  creditsUsed?: number;
  creditsSource?: string;
  elapsedMs?: number;
  error?: string;
  sweepId?: number;
  callId?: string;
  createdAt: string;
}

export interface AgentEventRow {
  id: number;
  ts: string;
  level: string;
  event: string;
  conversationId?: number;
  taskId?: number;
  callId?: string;
  sweepId?: number;
  data?: unknown;
}

export interface RunSummary {
  runEntryId: number;
  conversationId: number;
  agent: string;
  requestId?: string;
  sweepId?: number;
  text?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  generations: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface RunDetail extends RunSummary {
  generations: number;
  generationRows: GenerationRow[];
  toolCallRows: ToolCallRow[];
  children: RunDetail[];
  jevCalls: JevCallRow[];
  firecrawlCalls: FirecrawlCallRow[];
  events: AgentEventRow[];
}

export interface ToolCallDetail extends ToolCallRow {
  generation?: GenerationRow;
  jevCalls: JevCallRow[];
  firecrawlCalls: FirecrawlCallRow[];
  childRuns: RunSummary[];
  events: AgentEventRow[];
}

export interface UsageDay {
  day: string;
  modelUsd: number;
  jevUsd: number;
  imageUsd: number;
  tokensIn: number;
  tokensOut: number;
  jevCalls: number;
  firecrawlCredits: number;
  sweeps: number;
}

export interface LogLine {
  ts: string;
  level: string;
  app: string;
  event: string;
  [key: string]: unknown;
}

/** SSE frames on GET /v1/stream. `disconnected` is client-side only: follow() emits it between connections. */
export type Frame =
  | {
      type: "hello";
      apiVersion: typeof API_VERSION;
      serverTime: number;
      device: string;
      mainConversationId: number;
    }
  | { type: "agent.snapshot"; conversationId: number; snapshot: WireSnapshotEvent }
  | { type: "agent.batch"; conversationId: number; events: WireAgentEvent[] }
  | { type: "feed.card"; card: Card }
  | { type: "feed.card_updated"; card: Card }
  | { type: "sweep"; sweep: Sweep }
  | { type: "taste.question"; question: TasteQuestion }
  | { type: "agent.state"; state: AgentState }
  | { type: "usage"; usage: UsageDay }
  /** The agent opened a feed tab (open_tab) in every open browser. */
  | { type: "ui.open_tab"; by: TabBy; value: string }
  /** The agent pointed at a card (highlight_item): switch to News, scroll to it and flash it. */
  | { type: "ui.highlight"; card: Card }
  /** The schedule changed (the top bar, the CLI or set_schedule). */
  | { type: "schedule"; schedule: ScheduleState }
  /** The agent changed keywords (edit_keyword, card_feedback): the new list. */
  | { type: "taste.keywords"; keywords: Keyword[] }
  | { type: "disconnected"; reason: string };

export type WhenBusy = "followUp" | "steer";

export interface SendMessageBody {
  content: string;
  /** Retries with the same requestId never submit twice. */
  requestId: string;
  mode?: WhenBusy;
  /** Wait up to this long for the answer (max 300000). */
  waitMs?: number;
}

export type SendResult =
  | { submissionId: number; status: "queued" | "pending" }
  | { submissionId: number; status: "done"; answer: { entryId: number; text: string } }
  | { submissionId: number; status: "unanswered"; reason?: string };

export interface WorkflowResult {
  /** not_due: a scheduled tick that is not due (the schedule is off, or this slot already swept). */
  status: "accepted" | "replay" | "skipped" | "not_due";
  sweep?: Sweep;
  reason?: string;
  submissionId?: number;
}

/** Persisted cron plus process-local ticker liveness. Use cronExpression, not everyMinutes, for off. */
export interface ScheduleState {
  /** Legacy interval projection; null also represents custom cron expressions. */
  everyMinutes: number | null;
  /** The most cards one sweep presents; jev ranks the candidates and keeps the top ones. */
  cardsPerSweep: number;
  /** Intervals this device's cron tick can keep. */
  presets: number[];
  /** How often the crontab ticks, in minutes. */
  tickMinutes: number;
  nextSweepAt?: string;
  cronExpression?: string | null;
  timezone?: string;
  schedulerStatus?: "waiting" | "running" | "stale";
  lastTickAt?: string;
  /** Configured next slot, even when the ticker is waiting/stale. */
  nextScheduledAt?: string;
}

export interface CardDetail {
  card: Card;
  item?: {
    id: number;
    title: string;
    url: string;
    sourceName?: string;
    publishedAt?: string;
    excerpt?: string;
    status: string;
    relevance?: number;
    worth?: number;
    novelty?: number;
    matchedTopic?: string;
    discussionUrl?: string;
  };
  findings: {
    id: number;
    summary: string;
    claims: string[];
    evidence: string[];
    actionability?: string;
    claimSupport: { claim: string; supported: number }[];
    createdAt: string;
  }[];
  toolCall?: ToolCallRow;
}

export interface FeedbackBody {
  signal?: "more" | "less";
  labels?: HfsCategory[];
}

export interface FeedbackResult {
  changed: { id: number; term: string; kind: string; from: number; to: number }[];
  /** Sites this upvote left for the next sweep to save as sources. */
  leads?: SourceLead[];
}

export interface AgentConfigBody {
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** The quick model for one-shot jobs (publish dates). */
  quickModel?: string;
  quickThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** The deep-research subagents (deep_dive_research). */
  deepResearchModel?: string;
  deepResearchThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** How many deep-research subagents one deep dive starts, 1 to 5. */
  deepResearchCount?: number;
}

export interface CompactionBody {
  background?: number;
  force?: number;
  enabled?: boolean;
}

export interface LogQuery {
  /** One app's log; leave out (and apps) for every app. */
  app?: string;
  /** Several apps, comma separated: api,cron. */
  apps?: string;
  /** Minimum level. */
  level?: "debug" | "info" | "warn" | "error";
  /** Exact levels, comma separated: warn,error. */
  levels?: string;
  sweepId?: number;
  conversationId?: number;
  callId?: string;
  limit?: number;
}
