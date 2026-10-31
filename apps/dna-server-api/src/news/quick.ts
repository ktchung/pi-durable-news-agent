// The quick model: one-shot jobs (reading a publish date out of a page today) on a small, cheap model the reader picks
// next to the agent's model. Saved in settings; Haiku 5.5 with thinking off by default.
import type { ModelCatalog } from "@dna/durable-agent";
import type { Logger } from "@dna/sdk/node";
import type { Store } from "../db/store.ts";
import { catalogSelection, selectModel, type ModelSelection } from "./model-selection.ts";

export type QuickThinking = ModelSelection["thinkingLevel"];

export interface QuickSetting {
  model: string;
  thinkingLevel: QuickThinking;
}

export const DEFAULT_QUICK: QuickSetting = {
  model: "anthropic/claude-haiku-5.5",
  thinkingLevel: "off",
};

export class Quick {
  constructor(private readonly deps: { catalog: ModelCatalog; store: Store; log: Logger }) {}

  setting(): QuickSetting {
    const saved = { ...DEFAULT_QUICK, ...this.deps.store.settings.get("quick", DEFAULT_QUICK) };
    const { catalog } = this.deps;
    return catalog.provider === "codex" ? catalogSelection(catalog, saved) : saved;
  }

  set(patch: Partial<QuickSetting>): QuickSetting {
    const next = selectModel(this.deps.catalog, this.setting(), patch, "quickThinking");
    this.deps.store.settings.set("quick", next);
    this.deps.log.info("quick.configured", { ...next });
    return next;
  }

  /** One system prompt, one user message, the reply's text. Throws on provider errors. */
  async ask(
    label: string,
    system: string,
    user: string,
  ): Promise<{ text: string; costUsd: number }> {
    const { model: id, thinkingLevel } = this.setting();
    const { catalog, log } = this.deps;
    const ref = catalog.ref(id);
    const model = catalog.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`The quick model ${id} is not available`);
    const started = Date.now();
    const reply = await catalog.models.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: started }] },
      {
        maxTokens: 400,
        signal: AbortSignal.timeout(30_000),
        ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
      },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(reply.errorMessage ?? `The quick model stopped: ${reply.stopReason}`);
    const text = reply.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    const costUsd = reply.usage?.cost?.total ?? 0;
    log.info("quick.call", {
      label,
      model: id,
      input: reply.usage?.input,
      output: reply.usage?.output,
      costUsd,
      ms: Date.now() - started,
    });
    return { text, costUsd };
  }
}
