// Resolve model/effort pairs from the active catalog, never from a provider-wide effort list.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelCatalog } from "@dna/durable-agent";
import { invalid } from "../errors.ts";

export interface ModelSelection {
  model: string;
  thinkingLevel: ModelThinkingLevel;
}

export function selectModel(
  catalog: ModelCatalog,
  current: { model: string; thinkingLevel?: string },
  patch: { model?: string; thinkingLevel?: string },
  thinkingKey = "thinkingLevel",
): ModelSelection {
  const model = patch.model ?? current.model;
  const info = catalog.info(model);
  if (!info)
    throw invalid(
      `Unknown model ${model}. Known: ${catalog
        .list()
        .map((m) => m.id)
        .join(", ")}`,
    );
  const levels = info.thinkingLevels ?? [];
  if (patch.thinkingLevel !== undefined && !levels.includes(patch.thinkingLevel))
    throw invalid(
      `${thinkingKey} ${patch.thinkingLevel} is not supported by ${model}. Supported: ${levels.join(", ") || "none"}`,
    );
  const thinkingLevel =
    patch.thinkingLevel ??
    (current.thinkingLevel !== undefined && levels.includes(current.thinkingLevel)
      ? current.thinkingLevel
      : info.defaultThinkingLevel !== undefined && levels.includes(info.defaultThinkingLevel)
        ? info.defaultThinkingLevel
        : levels[0]);
  if (thinkingLevel === undefined) throw invalid(`Model ${model} has no supported thinking levels`);
  return { model, thinkingLevel: thinkingLevel as ModelThinkingLevel };
}

/** Reconcile saved settings after subscription catalogs change, without writing on reads. */
export function catalogSelection(catalog: ModelCatalog, saved: ModelSelection): ModelSelection {
  return selectModel(
    catalog,
    catalog.info(saved.model) ? saved : { model: catalog.defaultModel.modelId },
    {},
  );
}
