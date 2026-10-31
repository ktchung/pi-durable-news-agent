// Tools that act for the reader the way the browser's controls do: vote and label a card (card_feedback), change
// keywords (edit_keyword), rank a source (edit_source), open a feed tab (open_tab) and point at a card (highlight_item). Votes and rank moves add to
// weights, so their effect is kept once per call: a replay after a crash returns the first result.
import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, once, toolError, toolText } from "@dna/durable-agent";
import { HFS_CATEGORIES, TAB_BYS, type Card, type Keyword, type Source } from "@dna/sdk";
import type { Deps } from "../../deps.ts";
import { clamp } from "../../db/repos/taste.ts";
import { MAX_CARDS } from "../../news/schedule.ts";
import { applyFeedback } from "../../news/taste.ts";

const VOTES = ["up", "down"] as const;
const ACTIONS = ["add", "remove", "enable", "disable", "rank_up", "rank_down"] as const;
const KINDS = ["topic", "hype", "facts", "signal"] as const;
const SOURCE_ACTIONS = ["rank_up", "rank_down"] as const;
/** One rank step: 10 points of weight. */
export const RANK_STEP = 0.1;

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const cardLine = (c: Card) =>
  `card ${c.id} "${c.title}"${c.publishedAt ? ` (published ${c.publishedAt.slice(0, 10)})` : ""}`;
const keywordLine = (k: Keyword) =>
  `#${k.id} ${k.kind} "${k.term}" weight ${k.weight.toFixed(2)}${k.enabled ? "" : " (off)"}`;

export const sourceLine = (s: Source) =>
  `#${s.id} ${s.kind} "${s.name}" weight ${s.weight.toFixed(2)}${s.enabled ? "" : " (off)"}`;

const CARD_PARAMS = {
  card_id: Type.Optional(Type.Integer()),
  item_id: Type.Optional(Type.Integer()),
};

function findCard(deps: Deps, args: { card_id?: number; item_id?: number }) {
  if (args.card_id) return deps.store.news.card(args.card_id);
  if (args.item_id) return deps.store.news.cardForItem(args.item_id);
  return undefined;
}

function noCard(args: { card_id?: number; item_id?: number }) {
  return toolError(
    args.card_id
      ? `No card #${args.card_id}.`
      : args.item_id
        ? `Item #${args.item_id} has no news card.`
        : "Give card_id or item_id.",
    ['Use a card id from present_news or the reader\'s message (card 22 "Title").'],
  );
}

function publishKeywords(deps: Deps) {
  deps.bus.publish({ type: "taste.keywords", keywords: deps.store.taste.keywords() });
}

export function cardFeedback(deps: Deps) {
  return defineAppTool({
    name: "card_feedback",
    returns:
      "Text: the card and what was recorded, then each keyword weight that moved (term, from, to).",
    description:
      "Vote on a card or label it for the reader, exactly like the card's buttons. vote up is show me more and vote down is show me less: both move the card's topic weight. labels sets its Hype, Facts and Signal labels (an empty list clears them) and moves those keywords. Use it only when the reader asks. Give card_id, or item_id for the item's card.",
    parameters: Type.Object({
      ...CARD_PARAMS,
      vote: Type.Optional(literals(VOTES)),
      labels: Type.Optional(Type.Array(literals(HFS_CATEGORIES), { maxItems: 3 })),
    }),
    enums: { vote: VOTES },
    example: { card_id: 22, vote: "down" },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const card = findCard(deps, args);
      if (!card) return noCard(args);
      if (!args.vote && !args.labels)
        return toolError("card_feedback needs vote, labels, or both.");
      const text = await once(api, "card_feedback", ctx, async () => {
        const signal = args.vote ? (args.vote === "up" ? "more" : "less") : undefined;
        const labels = args.labels ? [...new Set(args.labels)] : undefined;
        const result = applyFeedback(deps.store, card, { signal, labels });
        deps.log.info("taste.feedback", {
          cardId: card.id,
          signal,
          labels,
          changed: result.changed.length,
          leads: result.leads.map((l) => l.site),
          by: "agent",
        });
        deps.bus.publish({ type: "feed.card_updated", card: deps.store.news.card(card.id)! });
        if (result.changed.length) publishKeywords(deps);
        const did = [
          args.vote && `voted ${args.vote}`,
          labels && `labeled ${labels.join(", ") || "none"}`,
        ].filter(Boolean);
        return [
          `${cardLine(card)}: ${did.join(", ")}.`,
          result.changed.length
            ? `Moved: ${result.changed.map((c) => `${c.term} ${c.from.toFixed(2)} to ${c.to.toFixed(2)}`).join(", ")}.`
            : "No keyword weight moved.",
          result.leads.length
            ? `New source leads: ${result.leads.map((l) => l.site).join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      });
      return toolText(text, { cardId: card.id });
    },
  });
}

export function editKeyword(deps: Deps) {
  return defineAppTool({
    name: "edit_keyword",
    returns:
      "Text: the keyword after the change (id, section, term, weight, off when disabled), or the one removed.",
    description:
      "Change the reader's keywords like the Taste settings do. add puts a term in a section (topic steers what sweeps search; hype, facts and signal steer jev). remove deletes one, enable and disable turn one on or off, rank_up (boost, raise) and rank_down (lower) move its weight by 0.10 (weights stay between 0.10 and 2.00). Name the keyword by keyword_id from read_taste, or by term (with kind when two sections share it). Use it only when the reader asks.",
    parameters: Type.Object({
      action: literals(ACTIONS),
      term: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      kind: Type.Optional(literals(KINDS)),
      keyword_id: Type.Optional(Type.Integer()),
    }),
    enums: { action: ACTIONS, kind: KINDS },
    example: { action: "rank_down", term: "agent sdk" },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { taste } = deps.store;
      const term = args.term?.trim();
      if (args.action === "add") {
        if (!term) return toolError("edit_keyword add needs a term.");
        const kind = args.kind ?? "topic";
        const known = taste.findKeyword(kind, term);
        if (known?.enabled) return toolText(`Already a keyword: ${keywordLine(known)}.`);
        const added = taste.addKeyword(kind, term);
        deps.log.info("taste.keyword_added", { id: added.id, kind, term, by: "agent" });
        publishKeywords(deps);
        return toolText(`Added ${keywordLine(added)}.`);
      }
      const matches = (
        args.keyword_id
          ? [taste.keyword(args.keyword_id)]
          : term
            ? (args.kind ? [args.kind] : KINDS).map((kind) => taste.findKeyword(kind, term))
            : []
      ).filter((k): k is Keyword => !!k);
      if (!matches.length)
        return toolError(
          args.keyword_id
            ? `No keyword #${args.keyword_id}.`
            : term
              ? `No keyword "${term}"${args.kind ? ` in ${args.kind}` : ""}.`
              : `edit_keyword ${args.action} needs keyword_id or term.`,
          [
            "Call read_taste for the keywords and their ids.",
            ...(term && (args.action === "rank_up" || args.action === "rank_down")
              ? [
                  `To boost a term that is not a keyword yet, add it first: {"action": "add", "term": "${term}"}.`,
                ]
              : []),
          ],
        );
      if (matches.length > 1)
        return toolError(`"${term}" is in ${matches.map((k) => k.kind).join(" and ")}.`, [
          "Give kind or keyword_id.",
        ]);
      const k = matches[0];
      const text = await once(api, "edit_keyword", ctx, async () => {
        let line: string;
        if (args.action === "remove") {
          taste.removeKeyword(k.id);
          line = `Removed ${keywordLine(k)}.`;
        } else if (args.action === "enable" || args.action === "disable") {
          const after = taste.updateKeyword(k.id, { enabled: args.action === "enable" })!;
          line = `${args.action === "enable" ? "Enabled" : "Disabled"} ${keywordLine(after)}.`;
        } else {
          const after = taste.nudge(k.id, args.action === "rank_up" ? RANK_STEP : -RANK_STEP)!;
          line =
            after.weight === k.weight
              ? `${keywordLine(k)} is already at its ${args.action === "rank_up" ? "2.00 cap" : "0.10 floor"}.`
              : `Ranked ${args.action === "rank_up" ? "up" : "down"}: ${keywordLine(after)} (was ${k.weight.toFixed(2)}).`;
        }
        deps.log.info("taste.keyword_edited", { id: k.id, action: args.action, by: "agent" });
        publishKeywords(deps);
        return line;
      });
      return toolText(text);
    },
  });
}

export function editSource(deps: Deps) {
  return defineAppTool({
    name: "edit_source",
    returns: "Text: the source after the change (id, kind, name, weight, off when disabled).",
    description:
      "Change a source's weight like the Sources settings do. rank_up (boost, raise) and rank_down (lower) move its weight by 0.10 (weights stay between 0.10 and 2.00). The weight multiplies the rank of every item from that source. Name the source by source_id from read_taste, or by its name. Use it only when the reader asks.",
    parameters: Type.Object({
      action: literals(SOURCE_ACTIONS),
      source_id: Type.Optional(Type.Integer()),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    }),
    enums: { action: SOURCE_ACTIONS },
    example: { action: "rank_down", name: "pi changelog" },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { sources } = deps.store;
      const name = args.name?.trim().toLowerCase();
      const matches = args.source_id
        ? [sources.get(args.source_id)].filter((s): s is Source => !!s)
        : name
          ? sources.list().filter((s) => s.name.toLowerCase() === name)
          : [];
      if (!matches.length)
        return toolError(
          args.source_id
            ? `No source #${args.source_id}.`
            : name
              ? `No source named "${args.name!.trim()}".`
              : "edit_source needs source_id or name.",
          ["Call read_taste for the sources and their ids."],
        );
      if (matches.length > 1)
        return toolError(`${matches.length} sources are named "${args.name!.trim()}".`, [
          `Give source_id: ${matches.map((s) => s.id).join(" or ")}.`,
        ]);
      const s = matches[0];
      const text = await once(api, "edit_source", ctx, async () => {
        const up = args.action === "rank_up";
        const weight = clamp(Math.round((s.weight + (up ? RANK_STEP : -RANK_STEP)) * 100) / 100);
        const after = sources.update(s.id, { weight })!;
        deps.log.info("sources.edited", { id: s.id, action: args.action, weight, by: "agent" });
        return after.weight === s.weight
          ? `${sourceLine(s)} is already at its ${up ? "2.00 cap" : "0.10 floor"}.`
          : `Ranked ${up ? "up" : "down"}: ${sourceLine(after)} (was ${s.weight.toFixed(2)}).`;
      });
      return toolText(text);
    },
  });
}

export function openTab(deps: Deps) {
  return defineAppTool({
    name: "open_tab",
    returns:
      "Text: how many news cards matched and the newest of them (card id, title, publish date). The tab opens even when nothing matches.",
    description:
      "Open a tab in the reader's news column with the same search their search box runs. by search matches every word in a card's text, by keyword a topic keyword (the card's topic or a mention), by url an article link or a site (example.com). Use it when the reader asks to see, find or filter news, then answer briefly.",
    parameters: Type.Object({
      by: literals(TAB_BYS),
      value: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    enums: { by: TAB_BYS },
    example: { by: "keyword", value: "durable agents" },
    replay: "safe",
    execute: async (args) => {
      const value = args.value.trim();
      if (!value) return toolError("open_tab needs a value.");
      const cards = deps.store.news.searchCards(args.by, value, 50);
      deps.bus.publish({ type: "ui.open_tab", by: args.by, value });
      deps.log.info("ui.open_tab", { by: args.by, value, matches: cards.length });
      return toolText(
        cards.length
          ? [
              `Opened the ${args.by} tab "${value}": ${cards.length === 50 ? "50 or more news cards" : cards.length === 1 ? "1 news card" : `${cards.length} news cards`}. Newest:`,
              ...cards.slice(0, 8).map(cardLine),
            ].join("\n")
          : `Opened the ${args.by} tab "${value}": no news cards match yet.`,
      );
    },
  });
}

const EVERY = ["1", "5", "10", "15", "30", "60", "off"] as const;

export function setSchedule(deps: Deps) {
  return defineAppTool({
    name: "set_schedule",
    returns:
      "Text: how often scheduled sweeps now run, how many cards each presents, and when the next one starts.",
    description:
      "Change the sweep schedule, like the menus in the reader's top bar. every: how often scheduled sweeps run, every 1, 5, 10, 15, 30 or 60 minutes, or off. cards: the most cards one sweep presents, 1 to 30 (jev ranks the candidates and keeps the top ones). Give either or both. Use it only when the reader asks.",
    parameters: Type.Object({
      every: Type.Optional(literals(EVERY)),
      cards: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CARDS })),
    }),
    enums: { every: EVERY },
    example: { cards: 7 },
    replay: "safe",
    execute: async (args) => {
      if (args.every === undefined && args.cards === undefined)
        return toolError("set_schedule needs every, cards, or both.");
      const every =
        args.every === undefined ? undefined : args.every === "off" ? null : Number(args.every);
      const presets = deps.schedule.presets();
      if (every !== undefined && every !== null && !presets.includes(every))
        return toolError(
          `This device's cron ticks every ${deps.schedule.tick} minutes, so sweeps can run every ${presets.join(", ")} minutes.`,
        );
      const state = deps.schedule.set({
        ...(every !== undefined ? { everyMinutes: every } : {}),
        ...(args.cards !== undefined ? { cardsPerSweep: args.cards } : {}),
      });
      deps.bus.publish({ type: "schedule", schedule: state });
      deps.log.info("schedule.set", {
        everyMinutes: every,
        cardsPerSweep: args.cards,
        by: "agent",
      });
      return toolText(
        [
          state.cronExpression === null
            ? "Scheduled sweeps are off. The reader can still ask for news in chat."
            : `${state.everyMinutes === null ? `Sweeps follow cron ${state.cronExpression} (${state.timezone})` : `Sweeps run every ${state.everyMinutes} minutes`}. Configured next slot: ${state.nextScheduledAt}. Ticker: ${state.schedulerStatus}${state.nextSweepAt ? `; next sweep at ${state.nextSweepAt}` : "; no live ticker confirmed"}.`,
          `Each sweep presents at most ${state.cardsPerSweep} cards.`,
        ].join(" "),
      );
    },
  });
}

export function highlightItem(deps: Deps) {
  return defineAppTool({
    name: "highlight_item",
    returns: "Text: the card the reader's browser scrolled to and highlighted.",
    description:
      "Point the reader at a news card: their browser switches to the News tab, scrolls to the card and highlights it. Give card_id, or item_id for the item's card. Use it when you tell the reader about one card they should look at.",
    parameters: Type.Object(CARD_PARAMS),
    example: { card_id: 22 },
    replay: "safe",
    execute: async (args) => {
      const card = findCard(deps, args);
      if (!card) return noCard(args);
      deps.bus.publish({ type: "ui.highlight", card });
      deps.log.info("ui.highlight", { cardId: card.id });
      return toolText(`Highlighted ${cardLine(card)} in the News tab.`, { cardId: card.id });
    },
  });
}
