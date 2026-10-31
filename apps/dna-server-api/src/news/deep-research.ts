// dna.deep-research: research the reader asked for, run in the background. deep_dive_research creates this task and its
// deep-research subagents in one commit and returns at once. The task asks every subagent in parallel and posts each
// answer to the main conversation as a follow-up the moment that subagent finishes, so the desk relays answers as they
// arrive. Subagents are found again by owner task and every submission has a request id, so a restart neither asks a
// subagent twice nor posts an answer twice.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, defineTask, type ConversationId } from "@earendil-works/pi-durable";
import { answerTextOf, loadPrompt, runParallel, type ModelCatalog } from "@dna/durable-agent";
import type { Logger } from "@dna/sdk/node";
import type { Store } from "../db/store.ts";
import type { Deps } from "../deps.ts";
import { catalogSelection, selectModel, type ModelSelection } from "./model-selection.ts";

export type DeepThinking = ModelSelection["thinkingLevel"];
export const MAX_DEEP_RESEARCHERS = 5;

export interface DeepResearchSetting {
  model: string;
  thinkingLevel: DeepThinking;
  /** How many deep-research subagents one deep dive runs. */
  count: number;
}

export const DEFAULT_DEEP_RESEARCH: DeepResearchSetting = {
  model: "anthropic/claude-haiku-5.5",
  thinkingLevel: "xhigh",
  count: 1,
};

export function deepResearchSetting(store: Store, catalog?: ModelCatalog): DeepResearchSetting {
  const saved = {
    ...DEFAULT_DEEP_RESEARCH,
    ...store.settings.get("deepResearch", DEFAULT_DEEP_RESEARCH),
  };
  return catalog?.provider === "codex" ? { ...saved, ...catalogSelection(catalog, saved) } : saved;
}

export function setDeepResearch(
  store: Store,
  log: Logger,
  patch: Partial<DeepResearchSetting>,
  catalog?: ModelCatalog,
): DeepResearchSetting {
  const current = deepResearchSetting(store, catalog);
  const next = {
    ...current,
    ...patch,
    ...(catalog ? selectModel(catalog, current, patch, "deepResearchThinking") : {}),
  };
  store.settings.set("deepResearch", next);
  log.info("deep_research.configured", { ...next });
  return next;
}

/** One angle per subagent when several run, so they cover different ground instead of the same search. */
export const ANGLES = [
  "primary sources: the organization's own site, announcements, docs, filings, code and the people involved",
  "independent verification: reporting, analysis and anyone who confirms or disputes the claims",
  "how it works: methodology, architecture, technical details, benchmarks and evidence",
  "people, money and history: who is behind it, funding, customers, track record and prior work",
  "criticism and open questions: skeptics, limits, risks, competitors and what is still unknown",
];
const ALL_ANGLES =
  "every angle: primary sources first, then independent verification and the details";

export interface DeepResearchInput {
  question: string;
  /** What the question is about: a card, an item, or what the reader said. */
  context: string;
  count: number;
}

export interface DeepResearchResult {
  answered: number;
  failed: number;
}

export function createDeepResearchTask(deps: Deps) {
  const agentsDir = join(deps.config.promptsDir, "agents");
  return defineTask<DeepResearchInput, { phase: "research" }, DeepResearchResult>({
    name: "dna.deep-research",
    version: 1,
    initial: () => ({ phase: "research" }),
    phases: {
      research: async (task, runtime, ctx: Context) => {
        const researchId = runtime.taskId as number;
        const { question, context, count } = task.input;
        let children: ConversationId[] = [];
        await runtime.commit(async (tx) => {
          children = (await tx.scanConversations({ ownerTaskId: runtime.taskId }, count + 5)).items
            .map((c) => c.id)
            .slice(0, count);
          return undefined;
        }, ctx);
        const main = await runtime.conversation(runtime.conversationId, ctx);
        if (!main) throw new Error("The main conversation is not available");
        let reported = 0;
        const results = await runParallel(children, children.length, async (child, i) => {
          const started = Date.now();
          let answer = "";
          let failure: string | undefined;
          try {
            const handle = await runtime.conversation(child, ctx);
            if (!handle) throw new Error(`deep-research subagent ${child} is not available`);
            const prompt = loadPrompt(agentsDir, "deep-research", "USER_PROMPT_deep_research.md", {
              research_id: researchId,
              index: i + 1,
              count: children.length,
              question,
              context,
              angle: children.length > 1 ? ANGLES[i % ANGLES.length] : ALL_ANGLES,
            });
            const submission = await handle.submit(
              { type: "input", content: prompt, requestId: `deep:${researchId}:${i}` },
              ctx,
            );
            const settled = await submission.wait(ctx);
            if (settled.status === "done" && settled.type === "input") {
              // The answer lives in the subagent's conversation, which runtime.entry() cannot see.
              await runtime.commit(async (tx) => {
                const entry = await tx.entry(AssistantEntry, settled.answer);
                answer = answerTextOf(entry?.model?.[0] as AssistantMessage | undefined);
                return undefined;
              }, ctx);
              if (!answer) failure = "it finished without an answer";
            } else
              failure = settled.status === "unanswered" ? settled.reason : String(settled.status);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            failure = String(error).slice(0, 300);
          }
          const report = loadPrompt(agentsDir, "news-desk", "USER_PROMPT_deep_research_report.md", {
            research_id: researchId,
            index: i + 1,
            count: children.length,
            reported: ++reported,
            question,
            status: failure ? `did not finish: ${failure}` : "answered",
            answer: answer || "none",
          });
          await main.submit(
            {
              type: "input",
              content: report,
              requestId: `deep:${researchId}:${i}:report`,
              whenBusy: "followUp",
            },
            ctx,
          );
          deps.log.info("deep_research.reported", {
            researchId,
            index: i + 1,
            count: children.length,
            conversationId: child as number,
            ok: !failure,
            failure,
            ms: Date.now() - started,
          });
          return !failure;
        });
        const answered = results.filter(Boolean).length;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { answered, failed: results.length - answered },
            },
          }),
          ctx,
        );
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}
