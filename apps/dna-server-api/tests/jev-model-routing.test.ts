// Offline provider-routing regression: captures requests, never calls providers.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JevClient, loadCommand, runCommand } from "@dna/jev";

const commandDir = fileURLToPath(new URL("../prompt_engineering/jev", import.meta.url));
const names = ["relevance", "worth-attention", "hfs", "same-story", "claim-support", "importance"];

test("shipped commands inherit distinct direct and routed provider model defaults", async () => {
  const previous = globalThis.fetch;
  const captured: Array<{ url: string; body: { model: string } }> = [];
  globalThis.fetch = (async (input, init) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("", { status: 400 });
  }) as typeof fetch;
  try {
    for (const name of names) {
      const command = loadCommand(name, commandDir);
      assert.equal(command.model, undefined, `${name} must inherit its provider default`);
      for (const [provider, model, endpoint] of [
        ["typesafe", "jev-latest", "https://api.typesafe.ai/v1/systemone"],
        ["openrouter", "~typesafe/jev-latest", "https://openrouter.ai/api/alpha/decisions"],
      ] as const) {
        const client = new JevClient({ provider, apiKey: "fixture" });
        await assert.rejects(
          client.systemOne(
            "Fixture",
            {
              check: { type: "noul", instructions: "Is this a fixture?" },
            },
            { model: command.model },
          ),
          /HTTP 400/,
        );
        assert.equal(captured.at(-1)?.url, endpoint);
        assert.equal(captured.at(-1)?.body.model, model);
      }
    }
    for (const name of ["relevance", "worth-attention"]) {
      const client = new JevClient({ provider: "typesafe", apiKey: "fixture" });
      await assert.rejects(
        runCommand(
          loadCommand(name, commandDir),
          {
            title: "Fixture",
            source: "Fixture",
            excerpt: "Synthetic fixture only.",
            published_at: "2026-01-01",
            topic_keywords: [{ term: "fixture", weight: 1 }],
            topic_choices: { fixture: "Fixture", none: "No match" },
            taste_examples: [],
          },
          (state, questions, options) => client.systemOne(state, questions, options),
        ),
        /HTTP 400/,
      );
      assert.equal(captured.at(-1)?.body.model, "jev-latest");
    }
    const client = new JevClient({ provider: "typesafe", apiKey: "fixture" });
    await assert.rejects(
      client.systemOne(
        "Fixture",
        {
          check: { type: "noul", instructions: "Is this a fixture?" },
        },
        { model: "jev-1.14.0" },
      ),
      /HTTP 400/,
    );
    assert.equal(captured.at(-1)?.body.model, "jev-1.14.0");
    assert.equal(captured.length, 15);
  } finally {
    globalThis.fetch = previous;
  }
});
