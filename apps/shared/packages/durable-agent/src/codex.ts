// Codex subscription discovery uses the same OAuth grant and backend as the
// Codex client. No OpenRouter/API-key fallback and no bundled picker entries.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
  CredentialStore,
  Model,
  ModelThinkingLevel,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { ModelCatalog, ModelInfo } from "./models.ts";
import { CodexCredentials } from "./codex-credentials.ts";

export const CODEX_CLIENT_VERSION = "0.165.0";
export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TTL = 10 * 60_000;
const CACHE_MAX_AGE = 24 * 60 * 60_000;

interface RemoteModel {
  slug: string;
  display_name: string;
  default_reasoning_level?: string | null;
  supported_reasoning_levels: { effort: string; description?: string }[];
  visibility: string;
  priority: number;
  context_window?: number | null;
  input_modalities?: string[];
  supports_reasoning_summary_parameter?: boolean;
}
interface ParsedModel {
  supportsReasoningSummary: boolean;
  model: Model<"openai-codex-responses">;
  info: ModelInfo;
}

/** Only choices returned by Codex and representable by pi-ai become options. */
export function parseCodexModels(payload: unknown): ParsedModel[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { models?: unknown }).models)
  )
    throw new Error("Invalid Codex catalog envelope");
  const known = openaiCodexProvider().getModels();
  const seen = new Set<string>();
  const rows = (payload as { models: RemoteModel[] }).models;
  const result: ParsedModel[] = [];
  for (const row of [...rows].sort((a, b) => (a?.priority ?? 1000) - (b?.priority ?? 1000))) {
    if (
      !row ||
      row.visibility !== "list" ||
      typeof row.slug !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(row.slug) ||
      seen.has(row.slug) ||
      !Array.isArray(row.supported_reasoning_levels)
    )
      continue;
    const supported = row.supported_reasoning_levels
      .map((entry) => entry?.effort)
      .filter((level): level is string => typeof level === "string");
    const mapLevel = (level: string) => (level === "none" ? "off" : level);
    const levels = [...new Set(supported.map(mapLevel))].filter(
      (level): level is ModelThinkingLevel => LEVELS.includes(level as ModelThinkingLevel),
    );
    if (!levels.length) continue;
    const baseline = known.find((model) => model.id === row.slug);
    const window = row.context_window ?? baseline?.contextWindow;
    if (!Number.isSafeInteger(window) || (window ?? 0) < 4096) continue;
    // Availability/efforts always come from the account response. A known Pi
    // transport descriptor may fill missing context/output metadata, never IDs.
    const defaultLevel = row.default_reasoning_level
      ? mapLevel(row.default_reasoning_level)
      : undefined;
    const preferred = levels.includes(defaultLevel as ModelThinkingLevel)
      ? defaultLevel!
      : levels[0];
    const thinkingLevelMap = Object.fromEntries(
      LEVELS.map((level) => [
        level,
        levels.includes(level) ? (level === "off" ? "none" : level) : null,
      ]),
    );
    const model: Model<"openai-codex-responses"> = {
      ...baseline,
      type: "chat",
      id: row.slug,
      name: typeof row.display_name === "string" ? row.display_name : row.slug,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: window!,
      maxTokens: baseline?.maxTokens ?? Math.min(window!, 16384),
      input: row.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
      reasoning: levels.some((level) => level !== "off"),
      thinkingLevelMap,
      // Included subscription quota is not metered API USD. No invented prices.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    result.push({
      supportsReasoningSummary: row.supports_reasoning_summary_parameter !== false,
      model,
      info: {
        id: model.id,
        name: model.name,
        tier: "Subscription",
        icon: "openai.png",
        provider: "codex",
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        cost: { input: 0, output: 0 },
        thinkingLevels: levels,
        defaultThinkingLevel: preferred,
      },
    });
    seen.add(row.slug);
  }
  if (!result.length) throw new Error("Codex returned no compatible visible models");
  return result;
}

export interface CodexCatalogOptions {
  authDir: string;
  defaultModel?: string;
  credentials?: CredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function createCodexCatalog(
  options: CodexCatalogOptions,
): Promise<ModelCatalog & { close(): void }> {
  const ownedStore = options.credentials
    ? undefined
    : new CodexCredentials(join(options.authDir, "credentials.sqlite"));
  const credentials = options.credentials ?? ownedStore!;
  const base: Provider = openaiCodexProvider();
  const models: MutableModels = createModels({ credentials });
  let entries: ParsedModel[] = [];
  // Reuse Pi's Codex streaming/tool protocol, but replace BOTH static accessors.
  const available = () =>
    refreshedAt && now() - Date.parse(refreshedAt) < CACHE_MAX_AGE ? entries : [];
  const guardPayload = (payload: unknown, id: string) => {
    if (
      entries.find((entry) => entry.info.id === id)?.supportsReasoningSummary !== false ||
      !payload ||
      typeof payload !== "object"
    )
      return payload;
    const body = payload as Record<string, unknown>;
    if (!body.reasoning || typeof body.reasoning !== "object") return payload;
    const reasoning = { ...(body.reasoning as Record<string, unknown>) };
    delete reasoning.summary;
    return { ...body, reasoning };
  };
  models.setProvider({
    ...base,
    stream: (model, context, opts) =>
      base.stream(
        model,
        context,
        Object.assign({}, opts, {
          onPayload: async (
            payload: unknown,
            current: Model<import("@earendil-works/pi-ai").Api>,
          ) => guardPayload((await opts?.onPayload?.(payload, current)) ?? payload, model.id),
        }),
      ),
    streamSimple: (model, context, opts) =>
      base.streamSimple(model, context, {
        ...opts,
        onPayload: async (payload, current) =>
          guardPayload((await opts?.onPayload?.(payload, current)) ?? payload, model.id),
      }),
    getModels: () => available().map((entry) => entry.model),
    getAllModels: () => available().map((entry) => entry.model),
  } satisfies typeof base);
  const now = options.now ?? Date.now;
  let refreshedAt: string | undefined;
  let stale = false;
  let error: string | undefined;
  let lastAttempt = 0;
  let activeAccount: string | undefined;
  let pending: Promise<void> | undefined;
  const cacheFile = join(options.authDir, "models-cache.json");
  const accountTag = (credential: OAuthCredential) =>
    createHash("sha256")
      .update(String(credential.accountId ?? ""))
      .digest("hex");

  const refresh = async (force = false) => {
    if (pending) return pending;
    if (
      !force &&
      ((refreshedAt && !stale && now() - Date.parse(refreshedAt) < TTL) ||
        (lastAttempt && now() - lastAttempt < 30000))
    )
      return;
    pending = (async () => {
      lastAttempt = now();
      try {
        const stored = await credentials.read(base.id);
        if (stored?.type !== "oauth") {
          entries = [];
          throw new Error("Codex login required");
        }
        if (activeAccount && accountTag(stored) !== activeAccount) {
          entries = [];
          refreshedAt = undefined;
        }
        activeAccount = accountTag(stored);
        const auth = await models.getAuth(base.id, { signal: AbortSignal.timeout(20000) });
        const current = await credentials.read(base.id);
        if (
          !auth?.auth.apiKey ||
          current?.type !== "oauth" ||
          typeof current.accountId !== "string"
        )
          throw new Error("Codex login required");
        const response = await (options.fetch ?? fetch)(
          `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`,
          {
            headers: {
              Authorization: `Bearer ${auth.auth.apiKey}`,
              "ChatGPT-Account-ID": current.accountId,
              originator: "pi",
              "User-Agent": `pi-durable-news-agent/${CODEX_CLIENT_VERSION}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          },
        );
        if (!response.ok) throw new Error("Codex metadata request failed");
        const payload: unknown = await response.json();
        const parsed = parseCodexModels(payload);
        const timestamp = new Date(now()).toISOString();
        // Publish only successfully parsed complete metadata. Cache failure does
        // not turn a valid live discovery into a false authentication error.
        entries = parsed;
        refreshedAt = timestamp;
        stale = false;
        error = undefined;
        if (!options.credentials) {
          try {
            writeFileSync(
              cacheFile + ".new",
              JSON.stringify({ account: accountTag(current), refreshedAt, payload }),
              { mode: 0o600 },
            );
            renameSync(cacheFile + ".new", cacheFile);
          } catch {
            error = "Live catalog loaded; local metadata cache could not be saved";
          }
        }
      } catch {
        stale = true;
        error = "Codex model discovery unavailable; check the dedicated login and VPN connection";
        // Never return a static Pi/OpenRouter fallback as a successful Codex list.
        if (!available().length) {
          entries = [];
          throw new Error(error);
        }
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  try {
    const credential = await credentials.read(base.id);
    if (credential?.type !== "oauth")
      throw new Error("Codex login required; run auth-login before starting the API");
    activeAccount = accountTag(credential);
    if (!options.credentials) {
      try {
        const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
        if (
          cache.account === accountTag(credential) &&
          typeof cache.refreshedAt === "string" &&
          now() - Date.parse(cache.refreshedAt) >= 0 &&
          now() - Date.parse(cache.refreshedAt) < CACHE_MAX_AGE
        ) {
          entries = parseCodexModels(cache.payload);
          refreshedAt = cache.refreshedAt;
          stale = true;
        }
      } catch {
        /* No valid account-bound cache: require a live catalog. */
      }
    }
    await refresh(true);
    const initial = options.defaultModel || entries[0]?.info.id;
    if (!initial || !entries.some((entry) => entry.info.id === initial))
      throw new Error("Configured Codex default model is not in this account's returned catalog");
    const ref = (id: string) => {
      if (!available().some((entry) => entry.info.id === id))
        throw new Error(`Unknown Codex model ${id}`);
      return { provider: base.id, modelId: id };
    };
    return {
      models,
      provider: "codex",
      get defaultModel() {
        const current = available();
        const preferred = current.find((entry) => entry.info.id === initial) ?? current[0];
        if (!preferred)
          throw new Error("Codex catalog expired or unavailable; refresh before running workflows");
        return ref(preferred.info.id);
      },
      list: () => available().map((entry) => entry.info),
      ref,
      info: (id) => available().find((entry) => entry.info.id === id)?.info,
      refresh,
      catalogState: () => ({ source: "codex", refreshedAt, stale, ...(error ? { error } : {}) }),
      close: () => ownedStore?.close(),
    };
  } catch (failure) {
    ownedStore?.close();
    throw failure;
  }
}
