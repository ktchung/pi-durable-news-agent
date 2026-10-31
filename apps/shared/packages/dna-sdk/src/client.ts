// Typed client for one dna-server-api. Works in browsers and Node (fetch and streams). `token` is optional: the
// browser hub injects it, so the browser never holds one.
import type {
  AgentConfigBody,
  AgentState,
  Card,
  CardDetail,
  CompactionBody,
  CompactionState,
  FeedbackBody,
  FeedbackResult,
  Frame,
  Info,
  Keyword,
  LogLine,
  LogQuery,
  Page,
  Timeline,
  TimelineSummary,
  ToolInfo,
  RunDetail,
  RunSummary,
  SendMessageBody,
  ScheduleState,
  SendResult,
  Source,
  SourceKind,
  TabBy,
  Sweep,
  TasteQuestion,
  TasteState,
  ToolCallDetail,
  ToolCallRow,
  UsageDay,
  WorkflowResult,
} from "./api.ts";
import { DnaError, type ErrorCode } from "./errors.ts";
import { ROUTES, routePath, type RouteId } from "./routes.ts";
import { readSse } from "./sse.ts";
import type { TranscriptItem } from "./transcript.ts";

export interface CallOptions {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface Raw<T> {
  status: number;
  headers: Headers;
  data: T;
}

export const newRequestId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class DnaClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(json: boolean, extra: Record<string, string> = {}) {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...extra,
    };
  }

  /** Call a route by id and keep status and headers. Every POST carries an Idempotency-Key. */
  async raw<T>(id: RouteId, options: CallOptions = {}): Promise<Raw<T>> {
    const route = ROUTES[id];
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const key = options.idempotencyKey ?? (route.method === "POST" ? newRequestId() : undefined);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + routePath(id, options.params, options.query), {
        method: route.method,
        signal,
        headers: this.headers(options.body !== undefined, key ? { "idempotency-key": key } : {}),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new DnaError("offline", `Cannot reach ${this.baseUrl}`, 0, { cause });
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
      const code: ErrorCode =
        error?.code ??
        (response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not_found"
              : "internal");
      throw new DnaError(
        code,
        error?.message ?? `${response.status} ${response.statusText}`,
        response.status,
      );
    }
    return { status: response.status, headers: response.headers, data: data as T };
  }

  async call<T>(id: RouteId, options: CallOptions = {}): Promise<T> {
    return (await this.raw<T>(id, options)).data;
  }

  /** Open GET /v1/stream and yield frames until it ends. Throws DnaError on failure. */
  async *stream(
    signal: AbortSignal,
    options: { conversations?: number[]; idleMs?: number } = {},
  ): AsyncGenerator<Frame> {
    const path = routePath("stream", {}, { conversations: options.conversations?.join(",") });
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        headers: { ...this.headers(false), accept: "text/event-stream" },
        signal,
      });
    } catch (cause) {
      if (signal.aborted) return;
      throw new DnaError("offline", `Cannot reach ${this.baseUrl}`, 0, { cause });
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { code?: ErrorCode; message?: string } }
        | undefined;
      const code: ErrorCode =
        body?.error?.code ?? (response.status === 401 ? "unauthorized" : "unavailable");
      throw new DnaError(
        code,
        body?.error?.message ?? `Stream failed (${response.status})`,
        response.status,
      );
    }
    try {
      for await (const message of readSse(response.body, options.idleMs))
        yield JSON.parse(message.data) as Frame;
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }

  // ------------------------------------------------------------ read
  healthz() {
    return this.call<{ ok: true; version: string; device: string; uptime: number }>("healthz");
  }
  info(refreshModels = false) {
    return this.call<Info>("info", { query: refreshModels ? { refreshModels: "1" } : {} });
  }
  sweeps(query: { limit?: number; before?: number } = {}) {
    return this.call<Sweep[]>("sweeps.list", { query });
  }
  sweep(id: number) {
    return this.call<Sweep & { toolCalls: unknown[] }>("sweeps.get", { params: { id } });
  }
  feed(query: { before?: number; limit?: number } = {}) {
    return this.call<Page<Card>>("feed", { query });
  }
  search(query: { q: string; by?: TabBy; limit?: number }) {
    return this.call<Card[]>("feed.search", { query });
  }
  schedule() {
    return this.call<ScheduleState>("schedule.get");
  }
  /** Five-field cron, null for off, or a legacy interval preset. Object form supports atomic edits. */
  setSchedule(
    value:
      | number
      | string
      | null
      | {
          cronExpression?: string | null;
          timezone?: string;
          cardsPerSweep?: number;
        },
    timezone?: string,
  ) {
    const body =
      typeof value === "object" && value !== null
        ? value
        : typeof value === "number"
          ? { everyMinutes: value }
          : { cronExpression: value, ...(timezone !== undefined ? { timezone } : {}) };
    return this.call<ScheduleState>("schedule.set", { body });
  }
  /** Explicit cron setter for UI controls; null pauses scheduled sweeps. */
  setCronSchedule(cronExpression: string | null, timezone?: string) {
    return this.setSchedule(cronExpression, timezone);
  }
  /** The most cards one sweep presents (1 to 30). */
  setCardsPerSweep(cardsPerSweep: number) {
    return this.call<ScheduleState>("schedule.set", { body: { cardsPerSweep } });
  }
  tools() {
    return this.call<ToolInfo[]>("agent.tools");
  }
  timelines(query: { limit?: number } = {}) {
    return this.call<TimelineSummary[]>("timelines.list", { query });
  }
  timeline(id: number) {
    return this.call<Timeline>("timelines.get", { params: { id } });
  }
  card(id: number) {
    return this.call<CardDetail>("cards.get", { params: { id } });
  }
  taste() {
    return this.call<TasteState>("taste.get");
  }
  questions(status: "open" | "answered" | "dismissed" | "all" = "open") {
    return this.call<TasteQuestion[]>("taste.questions", { query: { status } });
  }
  keywords(kind?: string) {
    return this.call<Keyword[]>("keywords.list", { query: { kind } });
  }
  sources() {
    return this.call<Source[]>("sources.list");
  }
  agent() {
    return this.call<AgentState>("agent.get");
  }
  compaction() {
    return this.call<CompactionState>("agent.compaction.get");
  }
  transcript(query: { conversationId?: number; format?: "json" | "markdown" } = {}) {
    return this.call<{
      conversationId: number;
      format: string;
      items?: TranscriptItem[];
      text?: string;
    }>("agent.transcript", { query });
  }
  runs(query: { sweepId?: number; conversationId?: number; before?: number; limit?: number } = {}) {
    return this.call<RunSummary[]>("executions.runs", { query });
  }
  run(id: number) {
    return this.call<RunDetail>("executions.run", { params: { id } });
  }
  toolCalls(query: { conversationId?: number; sweepId?: number; limit?: number }) {
    return this.call<ToolCallRow[]>("executions.toolCalls", { query });
  }
  toolCall(id: number) {
    return this.call<ToolCallDetail>("executions.toolCall", { params: { id } });
  }
  usage(days = 14) {
    return this.call<UsageDay[]>("usage", { query: { days } });
  }
  logs(query: LogQuery = {}) {
    return this.call<LogLine[]>("logs", { query: { ...query } });
  }

  // ------------------------------------------------------------ workflow (cron token)
  /** scheduled: a cron tick, which starts a sweep only when the schedule says it is due. */
  newsSweep(body: {
    requestId: string;
    trigger?: "cron" | "manual" | "test";
    scheduled?: boolean;
    /** This run's own card limit instead of the reader's setting. */
    cards?: number;
  }) {
    return this.raw<WorkflowResult>("workflow.newsSweep", { body, idempotencyKey: body.requestId });
  }

  // ------------------------------------------------------------ chat
  send(body: Omit<SendMessageBody, "requestId"> & { requestId?: string }) {
    const requestId = body.requestId ?? newRequestId();
    return this.call<SendResult>("agent.messages", {
      body: { ...body, requestId },
      idempotencyKey: requestId,
      timeoutMs: (body.waitMs ?? 0) + 30_000,
    });
  }
  abort() {
    return this.call<{ ok: true }>("agent.abort", { body: {} });
  }

  // ------------------------------------------------------------ feedback
  feedback(cardId: number, body: FeedbackBody) {
    return this.call<FeedbackResult>("cards.feedback", { params: { id: cardId }, body });
  }
  answer(questionId: number, labels: string[]) {
    return this.call<TasteQuestion>("taste.answer", {
      params: { id: questionId },
      body: { labels },
    });
  }

  // ------------------------------------------------------------ settings
  configure(body: AgentConfigBody) {
    return this.call<AgentState>("agent.config", { body });
  }
  setCompaction(body: CompactionBody) {
    return this.call<CompactionState>("agent.compaction.set", { body });
  }
  compact(instructions?: string) {
    return this.call<{ taskId: number }>("agent.compact", { body: { instructions } });
  }
  addKeyword(body: { kind: Keyword["kind"]; term: string; weight?: number }) {
    return this.call<Keyword>("keywords.add", { body });
  }
  updateKeyword(id: number, body: { weight?: number; enabled?: boolean; term?: string }) {
    return this.call<Keyword>("keywords.update", { params: { id }, body });
  }
  removeKeyword(id: number) {
    return this.call<{ ok: true }>("keywords.remove", { params: { id } });
  }
  addSource(body: {
    kind: SourceKind;
    name: string;
    url?: string;
    query?: string;
    weight?: number;
    intervalMin?: number;
  }) {
    return this.call<Source>("sources.add", { body });
  }
  updateSource(
    id: number,
    body: { name?: string; enabled?: boolean; weight?: number; intervalMin?: number },
  ) {
    return this.call<Source>("sources.update", { params: { id }, body });
  }
  removeSource(id: number) {
    return this.call<{ ok: true }>("sources.remove", { params: { id } });
  }
}

export type ConnectionState = "connecting" | "live" | "offline" | "unauthorized";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Keep one stream open: reconnect with backoff from 1 s to 15 s, and start every reconnect from the server's fresh
 * snapshot (streams never replay). Stops for good on `unauthorized`.
 */
export async function follow(
  open: (signal: AbortSignal) => AsyncIterable<Frame>,
  onFrame: (frame: Frame) => void,
  onState: (state: ConnectionState, error?: DnaError) => void,
  signal: AbortSignal,
) {
  let backoff = 1_000;
  while (!signal.aborted) {
    onState("connecting");
    try {
      for await (const frame of open(signal)) {
        if (frame.type === "hello") {
          backoff = 1_000;
          onState("live");
        }
        onFrame(frame);
      }
      if (signal.aborted) return;
      onFrame({ type: "disconnected", reason: "Stream ended" });
    } catch (error) {
      if (signal.aborted) return;
      const e =
        error instanceof DnaError
          ? error
          : new DnaError("offline", String((error as Error)?.message ?? error));
      onFrame({ type: "disconnected", reason: e.message });
      if (e.code === "unauthorized" || e.code === "forbidden") return onState("unauthorized", e);
      onState("offline", e);
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, 15_000);
  }
}
