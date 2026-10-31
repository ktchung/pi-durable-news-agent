// Synthetic metadata and credentials only. Never contacts a provider.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { createCodexCatalog, parseCodexModels } from "../src/codex.ts";
import { CodexCredentials } from "../src/codex-credentials.ts";

const row = (slug: string, efforts = ["low", "high", "xhigh"]) => ({
  slug,
  display_name: slug,
  default_reasoning_level: efforts.at(-1),
  supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
  visibility: "list",
  supported_in_api: false,
  priority: 0,
  context_window: 128000,
  input_modalities: ["text"],
});
const fakeCredential = (): OAuthCredential => ({
  type: "oauth",
  access: "synthetic-access-only",
  refresh: "synthetic-refresh-only",
  expires: Date.now() + 3600000,
  accountId: "synthetic-account",
});
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
  const store = new CodexCredentials(join(dir, "credentials.sqlite"));
  return {
    dir,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("actual returned IDs/efforts only; hidden models excluded but subscription-only API=false accepted", () => {
  const parsed = parseCodexModels({
    models: [
      row("fixture-main"),
      { ...row("hidden"), visibility: "hide" },
      row("fixture-off", ["none"]),
      row("unsupported-future", ["ultra"]),
      row("fixture-main"),
    ],
  });
  assert.deepEqual(
    parsed.map((entry) => entry.info.id),
    ["fixture-main", "fixture-off"],
  );
  assert.deepEqual(parsed[0].info.thinkingLevels, ["low", "high", "xhigh"]);
  assert.equal(parsed[0].info.defaultThinkingLevel, "xhigh");
  assert.deepEqual(getSupportedThinkingLevels(parsed[0].model), ["low", "high", "xhigh"]);
  assert.deepEqual(parsed[1].info.thinkingLevels, ["off"]);
  assert.deepEqual(getSupportedThinkingLevels(parsed[1].model), ["off"]);
  assert.equal(parsed[1].model.thinkingLevelMap?.off, "none");
  assert.throws(() => parseCodexModels({ models: [] }), /no compatible/);
  assert.throws(() => parseCodexModels({ error: "fixture" }), /envelope/);
});

test("catalog uses Codex account headers; coalesces refresh; failure is labeled stale without static fallback", async () => {
  const f = fixture();
  try {
    await f.store.modify("openai-codex", async () => fakeCredential());
    let calls = 0;
    let fail = false;
    let clock = Date.now();
    const catalog = await createCodexCatalog({
      authDir: f.dir,
      credentials: f.store,
      now: () => clock,
      fetch: async (input, init) => {
        calls++;
        assert.match(
          String(input),
          /^https:\/\/chatgpt.com\/backend-api\/codex\/models\?client_version=0\.165\.0$/,
        );
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer synthetic-access-only");
        assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
        assert.equal(headers.get("originator"), "pi");
        assert.equal(init?.redirect, "error");
        await delay(5);
        return fail
          ? new Response("private upstream body not exposed", { status: 503 })
          : Response.json({ models: [row(calls === 1 ? "fixture-a" : "fixture-b", ["high"])] });
      },
    });
    assert.deepEqual(
      catalog.list().map((model) => model.id),
      ["fixture-a"],
    );
    assert.deepEqual(
      catalog.models
        .getProvider("openai-codex")!
        .getModels()
        .map((model) => model.id),
      ["fixture-a"],
    );
    assert.equal(catalog.models.getProvider("openrouter"), undefined);
    assert.throws(() => catalog.ref("gpt-invented"), /Unknown/);
    await catalog.refresh!();
    assert.equal(calls, 1);
    await Promise.all([catalog.refresh!(true), catalog.refresh!(true)]);
    assert.equal(calls, 2);
    assert.deepEqual(
      catalog.list().map((model) => model.id),
      ["fixture-b"],
    );
    assert.equal(
      catalog.defaultModel.modelId,
      "fixture-b",
      "withdrawn defaults resolve against the current response",
    );
    fail = true;
    await catalog.refresh!(true);
    assert.equal(catalog.catalogState!().stale, true);
    assert.doesNotMatch(catalog.catalogState!().error!, /private upstream body/);
    assert.deepEqual(
      catalog.list().map((model) => model.id),
      ["fixture-b"],
    );
    clock += 25 * 3600000;
    assert.deepEqual(catalog.list(), []);
    assert.throws(() => catalog.ref("fixture-b"), /Unknown/);
    await assert.rejects(catalog.refresh!(true), /discovery unavailable/);
    catalog.close();
  } finally {
    f.close();
  }
});

test("disk metadata cache is account-bound, bounded-age and honestly marked stale on offline restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-cache-"));
  let catalog: Awaited<ReturnType<typeof createCodexCatalog>> | undefined;
  try {
    const seed = new CodexCredentials(join(dir, "credentials.sqlite"));
    await seed.modify("openai-codex", async () => fakeCredential());
    seed.close();
    catalog = await createCodexCatalog({
      authDir: dir,
      fetch: async () => Response.json({ models: [row("persisted-fixture")] }),
    });
    catalog.close();
    catalog = undefined;
    const offline = async () => new Response("fixture failure", { status: 503 });
    catalog = await createCodexCatalog({ authDir: dir, fetch: offline });
    assert.deepEqual(
      catalog.list().map((entry) => entry.id),
      ["persisted-fixture"],
    );
    assert.equal(catalog.catalogState!().stale, true);
    catalog.close();
    catalog = undefined;
    await assert.rejects(
      createCodexCatalog({ authDir: dir, fetch: offline, now: () => Date.now() + 25 * 3600000 }),
      /discovery unavailable/,
    );
    const changed = new CodexCredentials(join(dir, "credentials.sqlite"));
    await changed.modify("openai-codex", async () => ({
      ...fakeCredential(),
      accountId: "different-synthetic-account",
    }));
    changed.close();
    await assert.rejects(
      createCodexCatalog({ authDir: dir, fetch: offline }),
      /discovery unavailable/,
    );
  } finally {
    catalog?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no credential or first discovery failure cannot pretend to list available models", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const options = {
      authDir: f.dir,
      credentials: f.store,
      fetch: async () => {
        calls++;
        return new Response("fixture", { status: 401 });
      },
    };
    await assert.rejects(createCodexCatalog(options), /login required/);
    assert.equal(calls, 0);
    await f.store.modify("openai-codex", async () => fakeCredential());
    await assert.rejects(createCodexCatalog(options), /discovery unavailable/);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});

test("private store persists rotated grants; independent connections serialize refresh and cancellation cannot discard success", async () => {
  const f = fixture();
  const other = new CodexCredentials(join(f.dir, "credentials.sqlite"));
  try {
    assert.equal(statSync(f.dir).mode & 0o077, 0);
    assert.equal(statSync(join(f.dir, "credentials.sqlite")).mode & 0o077, 0);
    await f.store.modify("openai-codex", async () => ({ ...fakeCredential(), expires: 0 }));
    let refreshed = 0;
    const base = openaiCodexProvider();
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth!.oauth!,
          async refresh() {
            refreshed++;
            await delay(10);
            return {
              ...fakeCredential(),
              access: "synthetic-rotated-access",
              refresh: "synthetic-rotated-refresh",
            };
          },
        },
      },
    };
    const first = createModels({ credentials: f.store });
    const second = createModels({ credentials: other });
    first.setProvider(provider);
    second.setProvider(provider);
    const [a, b] = await Promise.all([first.getAuth(base.id), second.getAuth(base.id)]);
    assert.equal(refreshed, 1);
    assert.equal(a?.auth.apiKey, "synthetic-rotated-access");
    assert.equal(b?.auth.apiKey, "synthetic-rotated-access");
    const controller = new AbortController();
    await f.store.modify(
      base.id,
      async (current) => {
        controller.abort();
        return {
          ...current!,
          type: "oauth",
          refresh: "synthetic-last-rotation",
        } as OAuthCredential;
      },
      { signal: controller.signal },
    );
    assert.equal(
      ((await other.read(base.id)) as OAuthCredential).refresh,
      "synthetic-last-rotation",
    );
    await other.delete(base.id);
    assert.equal(await f.store.read(base.id), undefined);
  } finally {
    other.close();
    f.close();
  }
});

test("discovered model and advertised effort reach the Codex transport with app-owned OAuth, never OpenRouter", async () => {
  const f = fixture();
  try {
    const access = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
        }),
      ).toString("base64url"),
      "synthetic-signature",
    ].join(".");
    await f.store.modify("openai-codex", async () => ({ ...fakeCredential(), access }));
    const catalog = await createCodexCatalog({
      authDir: f.dir,
      credentials: f.store,
      fetch: async () =>
        Response.json({
          models: [
            {
              ...row("fixture-live-shape", ["low", "xhigh"]),
              supports_reasoning_summary_parameter: false,
            },
          ],
        }),
    });
    const model = catalog.models.getProvider("openai-codex")!.getModels()[0];
    let requests = 0;
    const result = await catalog.models.completeSimple(
      model,
      {
        messages: [{ role: "user", content: "Synthetic transport test only", timestamp: 0 }],
      },
      {
        reasoning: "xhigh",
        transport: "sse",
        fetch: async (url, options) => {
          requests++;
          assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
          const headers = new Headers(options?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${access}`);
          assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
          assert.equal(headers.get("originator"), "pi");
          const compressed = options?.body instanceof Uint8Array ? options.body : undefined;
          const body = JSON.parse(
            compressed
              ? headers.get("content-encoding") === "zstd"
                ? (await import("node:zlib")).zstdDecompressSync(compressed).toString("utf8")
                : Buffer.from(compressed).toString("utf8")
              : String(options?.body),
          );
          assert.equal(body.model, "fixture-live-shape");
          assert.equal(body.reasoning.effort, "xhigh");
          assert.equal(
            Object.hasOwn(body.reasoning, "summary"),
            false,
            "catalog summary incompatibility reaches serialized payload",
          );
          assert.equal(body.store, false);
          // Deliberate mocked HTTP rejection: assert serialization, not a fake successful completion.
          return Response.json(
            { error: { message: "Synthetic transport rejection" } },
            { status: 400 },
          );
        },
      },
    );
    assert.equal(requests, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /Synthetic transport rejection/);
    catalog.close();
  } finally {
    f.close();
  }
});

test("credential storage refuses a permissive directory or symlinked store", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-permissions-"));
  try {
    const loose = join(dir, "loose");
    mkdirSync(loose, { mode: 0o755 });
    assert.throws(() => new CodexCredentials(join(loose, "credentials.sqlite")), /private/);
    symlinkSync(join(dir, "target"), join(dir, "linked.sqlite"));
    assert.throws(() => new CodexCredentials(join(dir, "linked.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
