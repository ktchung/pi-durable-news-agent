// deep_dive_research: hand a question the reader wants dug into to deep-research subagents and return at once. The
// subagents and the background dna.deep-research task that drives them are created in one commit, at most once per
// call, and each subagent's answer comes back to the desk as its own message when it finishes.
import { Type } from "@earendil-works/pi-ai";
import { configure, type AgentChange, type Task } from "@earendil-works/pi-durable";
import { defineAppTool, onceInCommit, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import {
  deepResearchSetting,
  MAX_DEEP_RESEARCHERS,
  type DeepResearchInput,
} from "../../news/deep-research.ts";

export function deepDiveResearch(
  deps: Deps,
  task: Task<DeepResearchInput, any, any, object>,
  child: () => AgentChange,
) {
  return defineAppTool({
    name: "deep_dive_research",
    returns:
      "Text: the deep research id, how many deep-research subagents started, and their model and thinking level. Each subagent's answer arrives later as its own message.",
    description: `Start deep research on a question the reader asked you to dig into, investigate or deep dive, when one search and one read cannot answer it. Deep-research subagents follow links 2 to 10 pages deep in the background and each one's answer comes back as its own message when it finishes, so this returns at once. Give the question in full, and card_id or item_id when it is about a card. count (1 to ${MAX_DEEP_RESEARCHERS}) only when the reader names how many researchers; otherwise the reader's setting decides. Use it only when the reader asks.`,
    parameters: Type.Object({
      question: Type.String({ minLength: 5, maxLength: 2000 }),
      card_id: Type.Optional(Type.Integer()),
      item_id: Type.Optional(Type.Integer()),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DEEP_RESEARCHERS })),
    }),
    example: {
      question:
        "What does this release actually change, how was it measured, and who outside the vendor confirms it?",
      card_id: 42,
    },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { news } = deps.store;
      const card = args.card_id ? news.card(args.card_id) : undefined;
      if (args.card_id && !card)
        return toolError(`No card #${args.card_id}.`, [
          'Use a card id from the reader\'s message (card 22 "Title"), or leave card_id out.',
        ]);
      const itemId = card?.itemId ?? args.item_id;
      const item = itemId ? news.item(itemId) : undefined;
      if (args.item_id && !item) return toolError(`No item #${args.item_id}.`);
      const context = item
        ? [
            card ? `card ${card.id} "${card.title}"` : "",
            `item #${item.id} ${item.title} (${item.sourceName ?? "web"}) ${item.url}`,
            item.publishedAt ? `published ${item.publishedAt.slice(0, 10)}` : "",
            item.excerpt ? `excerpt: ${item.excerpt.slice(0, 600)}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "No card or item: the question is all you have.";
      const setting = deepResearchSetting(deps.store, deps.catalog);
      const count = args.count ?? setting.count;
      const agent = child();
      const started = await onceInCommit<{ researchId: number; children: number[] }>(
        api,
        ctx,
        async (tx) => {
          const researchId = (await tx.createTask(
            task,
            { question: args.question.trim(), context, count },
            {
              ownership: { kind: "conversation" },
              conversationId: api.conversationId,
              background: true,
            },
          )) as number;
          const children: number[] = [];
          for (let i = 0; i < count; i++) {
            const created = await tx.createConversation({
              ownership: { kind: "task", taskId: researchId as never },
            });
            await configure(tx, created.id, agent);
            children.push(created.id as number);
          }
          return { researchId, children };
        },
      );
      await api.details(started, ctx);
      deps.log.info("deep_research.started", {
        ...started,
        count,
        model: setting.model,
        thinkingLevel: setting.thinkingLevel,
        cardId: card?.id,
        itemId: item?.id,
      });
      return toolText(
        [
          `Started deep research #${started.researchId}: ${count} deep-research subagent${count === 1 ? "" : "s"} on ${setting.model}, thinking ${setting.thinkingLevel}.`,
          `Each answer arrives as its own message when that subagent finishes, usually in a few minutes. Tell the reader it started, then stop. Do not research the question yourself meanwhile.`,
        ].join("\n"),
        started,
      );
    },
  });
}
