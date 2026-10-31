// The main agent: state, model and thinking, compaction points, chat, abort, transcript, and the stream.
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import { toolDoc, validatePoints } from "@dna/durable-agent";
import {
  messageText,
  toMarkdown,
  toTranscript,
  type SendResult,
  type ToolInfo,
  type WireEntry,
  type WireMessage,
} from "@dna/sdk";
import { agentState } from "../agent-state.ts";
import {
  deepResearchSetting,
  MAX_DEEP_RESEARCHERS,
  setDeepResearch,
} from "../news/deep-research.ts";
import { selectModel } from "../news/model-selection.ts";
import { toolParams } from "../news/tool-params.ts";
import { ApiFault, invalid, notFound, optInt } from "../errors.ts";
import { bodyOf, bool, num, oneOf, str, type Handlers, type RouteDeps } from "./types.ts";

export function agentRoutes({
  app,
  hub,
}: RouteDeps): Handlers<
  | "agent.get"
  | "agent.config"
  | "agent.compaction.get"
  | "agent.compaction.set"
  | "agent.compact"
  | "agent.messages"
  | "agent.abort"
  | "agent.transcript"
  | "agent.tools"
  | "stream"
> {
  const { harness, ctx } = app.harness;

  async function conversationOf(id: number | undefined) {
    if (id === undefined || id === (app.main.id as number)) return app.main;
    const c = await harness.conversation(id as ConversationId, ctx);
    if (!c) throw notFound(`No conversation ${id}`);
    return c;
  }

  async function settled(
    submissionId: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<SendResult> {
    const submission = await harness.submission(submissionId as SubmissionId, ctx);
    if (!submission) throw notFound(`No submission ${submissionId}`);
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const stop = AbortSignal.any([AbortSignal.timeout(Math.min(waitMs, 300_000)), signal]);
      const waited = submission.wait(ctx);
      const aborted = new Promise<undefined>((r) =>
        stop.addEventListener("abort", () => r(undefined), { once: true }),
      );
      record = (await Promise.race([waited, aborted])) ?? (await submission.status(ctx));
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await harness.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? [])
        .map((m) => messageText(m as WireMessage))
        .join("")
        .trim();
      return {
        submissionId,
        status: "done",
        answer: { entryId: record.answer as number, text },
      };
    }
    if (record.status === "unanswered")
      return { submissionId, status: "unanswered", reason: record.reason };
    return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
  }

  /** Every tool once, with the agents that have it, read from the registrations the agents run with. */
  const tools: ToolInfo[] = (() => {
    const byName = new Map<string, ToolInfo>();
    for (const [agent, list] of Object.entries(app.agents.tools))
      for (const t of list) {
        const known = byName.get(t.name);
        if (known) {
          known.agents.push(agent);
          continue;
        }
        const doc = toolDoc(t.name);
        const definition = {
          name: t.name,
          description: t.description,
          parameters: JSON.parse(JSON.stringify(t.parameters)),
        };
        byName.set(t.name, {
          name: t.name,
          agents: [agent],
          description: t.description,
          params: toolParams(definition.parameters, doc?.enums),
          returns: doc?.returns,
          example: doc?.example,
          definition,
        });
      }
    return [...byName.values()];
  })();

  return {
    "agent.tools": (_req, res) => res.json(tools),
    "agent.get": async (_req, res) => res.json(await agentState(app)),
    "agent.config": async (req, res) => {
      const body = bodyOf(req);
      const effort = (key: string) => {
        const value = body[key];
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !value || value.length > 40)
          throw invalid(`${key} must be a non empty string of 40 characters or fewer`);
        return value;
      };
      const model = str(body, "model", { max: 120, optional: true });
      const thinkingLevel = effort("thinkingLevel");
      const quickModel = str(body, "quickModel", { max: 120, optional: true });
      const quickThinking = effort("quickThinking");
      const deepResearchModel = str(body, "deepResearchModel", { max: 120, optional: true });
      const deepResearchThinking = effort("deepResearchThinking");
      const deepResearchCount = num(body, "deepResearchCount", {
        min: 1,
        max: MAX_DEEP_RESEARCHERS,
        integer: true,
      });
      if (
        !model &&
        !thinkingLevel &&
        !quickModel &&
        !quickThinking &&
        !deepResearchModel &&
        !deepResearchThinking &&
        deepResearchCount === undefined
      )
        throw invalid(
          "Send model, thinkingLevel, quickModel, quickThinking, deepResearchModel, deepResearchThinking, deepResearchCount, or a mix",
        );
      // Plan every requested pair (and model reference) before any setting is written.
      // In particular, an invalid research effort must not partially change main/quick.
      const current = await app.main.agent(ctx);
      const main =
        model || thinkingLevel
          ? selectModel(
              app.catalog,
              {
                model: current.model?.modelId ?? app.catalog.defaultModel.modelId,
                thinkingLevel: current.thinkingLevel,
              },
              { model, thinkingLevel },
            )
          : undefined;
      const mainRef = main ? app.catalog.ref(main.model) : undefined;
      const quick =
        quickModel || quickThinking
          ? selectModel(
              app.catalog,
              app.quick.setting(),
              {
                model: quickModel,
                thinkingLevel: quickThinking,
              },
              "quickThinking",
            )
          : undefined;
      const deep =
        deepResearchModel || deepResearchThinking || deepResearchCount !== undefined
          ? selectModel(
              app.catalog,
              deepResearchSetting(app.store, app.catalog),
              {
                model: deepResearchModel,
                thinkingLevel: deepResearchThinking,
              },
              "deepResearchThinking",
            )
          : undefined;
      if (main) {
        await app.main.configure({ model: mainRef, thinkingLevel: main.thinkingLevel }, ctx);
        app.store.settings.set("model", main.model);
        await app.refreshModel();
      }
      if (quick) app.quick.set(quick);
      if (deep)
        setDeepResearch(
          app.store,
          app.log,
          {
            ...deep,
            ...(deepResearchCount !== undefined ? { count: deepResearchCount } : {}),
          },
          app.catalog,
        );
      app.log.info("agent.configured", { model, thinkingLevel });
      res.json(await agentState(app));
    },
    "agent.compaction.get": (_req, res) => res.json(app.compactionState()),
    "agent.compaction.set": (req, res) => {
      const body = bodyOf(req);
      const current = app.compactionState();
      const points = {
        background: num(body, "background", { integer: true }) ?? current.background,
        force: num(body, "force", { integer: true }) ?? current.force,
      };
      const problem = validatePoints(current.window, points);
      if (problem) throw invalid(problem);
      app.setCompaction({ points, enabled: bool(body, "enabled") });
      res.json(app.compactionState());
    },
    "agent.compact": async (req, res) => {
      const instructions = str(bodyOf(req), "instructions", { max: 2000, optional: true });
      const taskId = await app.main.compact(instructions, ctx);
      app.log.info("agent.compact", { taskId, instructions: !!instructions });
      res.status(202).json({ taskId });
    },
    "agent.messages": async (req, res) => {
      const body = bodyOf(req);
      const content = str(body, "content", { max: 100_000 });
      const requestId = str(body, "requestId", { max: 128 });
      const mode = oneOf(body.mode, "mode", ["followUp", "steer"] as const, true) ?? "followUp";
      const waitMs = num(body, "waitMs", { min: 0, max: 300_000, integer: true }) ?? 0;
      const submission = await app.main.submit(
        { type: "input", content, requestId: `chat:${requestId}`, whenBusy: mode },
        ctx,
      );
      app.log.info("agent.message", { submissionId: submission.id, mode, chars: content.length });
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      const result = await settled(submission.id as number, waitMs, closed.signal);
      res
        .status(result.status === "done" || result.status === "unanswered" ? 200 : 202)
        .json(result);
    },
    "agent.abort": async (_req, res) => {
      await app.main.abort(ctx, { background: false });
      app.log.warn("agent.aborted", {});
      res.json({ ok: true });
    },
    "agent.transcript": async (req, res) => {
      const conversation = await conversationOf(optInt(req.query.conversationId, "conversationId"));
      const format =
        oneOf(req.query.format, "format", ["json", "markdown"] as const, true) ?? "json";
      const view = await conversation.viewState(ctx);
      let entries: WireEntry[];
      try {
        entries = JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
      } finally {
        view.dispose();
      }
      const items = toTranscript(entries);
      res.json(
        format === "markdown"
          ? { conversationId: conversation.id, format, text: toMarkdown(items) }
          : { conversationId: conversation.id, format, items },
      );
    },
    stream: async (req, res) => {
      if (hub.closing) throw new ApiFault("unavailable", "The server is shutting down");
      await hub.serve(app, req, res);
    },
  };
}
