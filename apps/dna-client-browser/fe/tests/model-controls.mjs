// Isolated component check: no backend, credentials, or model execution.
// Run from the repository root: node apps/dna-client-browser/fe/tests/model-controls.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { port: 0 },
  plugins: [
    {
      name: "model-controls-test",
      resolveId(id) {
        if (id === "/model-controls-test.js") return id;
      },
      load(id) {
        if (id !== "/model-controls-test.js") return;
        return `
        import { createApp, h } from 'vue';
        import ModelControls from '/src/components/ModelControls.vue';
        import ModelPicker from '/src/components/ModelPicker.vue';
        import * as store from '/src/client/store.ts';
        import '/src/styles/tokens.css';
        import '/src/styles/app.css';
        window.fixture = store;
        createApp({ render: () => h('div', [h(ModelControls), store.ui.models ? h(ModelPicker) : null]) }).mount('#app');
      `;
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/model-controls-test.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="app"></div><script type="module" src="/model-controls-test.js"></script>',
    }),
  );
  await page.goto(`${server.resolvedUrls.local[0]}model-controls-test.html`);
  await page.waitForFunction(() => !!window.fixture);
  await page.evaluate(() => {
    const { info, feed, api } = window.fixture;
    const model = (id, levels) => ({
      id,
      name: id,
      tier: "test",
      icon: "openai.png",
      provider: "codex",
      contextWindow: 128000,
      reasoning: true,
      cost: { input: 0, output: 0 },
      ...(levels ? { thinkingLevels: levels, defaultThinkingLevel: levels[0] } : {}),
    });
    info.value = {
      models: [
        model("catalog-main", ["low", "xhigh", "max"]),
        model("catalog-quick", ["off"]),
        model("catalog-unknown"),
      ],
      defaultModel: "catalog-main",
      modelCatalog: { source: "codex", stale: true, error: "Offline fixture" },
    };
    let state = {
      model: "catalog-main",
      thinkingLevel: "xhigh",
      quick: { model: "catalog-quick", thinkingLevel: "off" },
      deepResearch: { model: "catalog-main", thinkingLevel: "max", count: 3 },
    };
    feed.apply({ type: "agent.state", state });
    window.configs = [];
    api.configure = async (body) => {
      window.configs.push(body);
      state = {
        ...state,
        ...(body.model ? { model: body.model, thinkingLevel: "off" } : {}),
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
        quick: {
          model: body.quickModel ?? state.quick.model,
          thinkingLevel:
            body.quickThinking ?? (body.quickModel ? "low" : state.quick.thinkingLevel),
        },
        deepResearch: {
          model: body.deepResearchModel ?? state.deepResearch.model,
          thinkingLevel:
            body.deepResearchThinking ??
            (body.deepResearchModel ? "off" : state.deepResearch.thinkingLevel),
          count: body.deepResearchCount ?? state.deepResearch.count,
        },
      };
      return state;
    };
  });
  const main = page.getByRole("combobox", { name: "Thinking level", exact: true });
  const quick = page.getByRole("combobox", { name: "Quick tasks thinking level", exact: true });
  const deep = page.getByRole("combobox", { name: "Deep research thinking level", exact: true });
  const values = (locator) =>
    locator
      .locator("option:not([disabled])")
      .evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(await values(main), ["low", "xhigh", "max"]);
  assert.deepEqual(await values(quick), ["off"]);
  assert.deepEqual(await values(deep), ["low", "xhigh", "max"]);
  await expect(main).toHaveValue("xhigh");
  await expect(deep).toHaveValue("max");
  assert.deepEqual(
    await values(page.getByRole("combobox", { name: "Deep research count", exact: true })),
    ["1", "2", "3", "4", "5"],
  );
  await main.selectOption("max");
  await deep.selectOption("xhigh");
  await page
    .getByRole("combobox", { name: "Quick tasks model", exact: true })
    .selectOption("catalog-main");
  await expect(quick).toHaveValue("low");
  assert.deepEqual(await values(quick), ["low", "xhigh", "max"]);
  await quick.selectOption("max");
  await page
    .getByRole("combobox", { name: "Deep research model", exact: true })
    .selectOption("catalog-unknown");
  await expect(deep).toBeDisabled();
  assert.deepEqual(await values(deep), []);
  assert.deepEqual(await page.evaluate(() => window.configs), [
    { thinkingLevel: "max" },
    { deepResearchThinking: "xhigh" },
    { quickModel: "catalog-main" },
    { quickThinking: "max" },
    { deepResearchModel: "catalog-unknown" },
  ]);
  console.log(
    "PASS all three effort controls use selected-model capabilities and preserve count options",
  );

  await page.getByRole("button", { name: "Choose a model", exact: true }).click();
  await expect(page.locator('[data-model="catalog-main"] .badge')).toHaveText("Default");
  await expect(page.getByRole("status")).toContainText("stale");
  await expect(page.getByRole("status")).toContainText("Offline fixture");
  await page.getByRole("textbox", { name: "Search models", exact: true }).fill("catalog-quick");
  await page.locator('[data-model="catalog-quick"]').click();
  await expect(main).toHaveValue("off");
  assert.deepEqual(await values(main), ["off"]);
  assert.deepEqual(await page.evaluate(() => window.configs.at(-1)), { model: "catalog-quick" });
  console.log(
    "PASS picker searches live models, uses server default, and leaves effort coercion to backend",
  );

  await page.evaluate(() => {
    window.fixture.api.info = async () => ({
      ...window.fixture.info.value,
      models: window.fixture.info.value.models.map((model) => ({
        ...model,
        thinkingLevels: ["medium"],
      })),
      modelCatalog: { source: "codex", refreshedAt: "2026-01-01T00:00:00Z", stale: false },
    });
  });
  await page.getByRole("button", { name: "Choose a model", exact: true }).click();
  await page.getByRole("button", { name: "Refresh model catalog", exact: true }).click();
  await expect(page.getByRole("status")).not.toContainText("stale");
  await expect(page.getByRole("status")).toContainText("2026-01-01");
  await expect(main).toHaveValue("");
  assert.deepEqual(await values(main), ["medium"]);
  await page.evaluate(() => {
    window.fixture.api.info = async () => {
      throw new Error("Fixture refresh failure");
    };
  });
  await page.getByRole("button", { name: "Refresh model catalog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh model catalog", exact: true }),
  ).toBeEnabled();
  assert.deepEqual(await values(main), ["medium"]);
  assert.equal(
    await page.evaluate(() => window.fixture.toast.value.text),
    "Fixture refresh failure",
  );
  await page.evaluate(() => {
    window.fixture.info.value = { ...window.fixture.info.value, models: [] };
  });
  for (const control of [main, quick, deep]) await expect(control).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Quick tasks model", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Deep research model", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Model catalog unavailable. Try refreshing.")).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS catalog refresh updates controls, retains data on failure, and disables unavailable capabilities",
  );
} finally {
  await browser?.close();
  await server.close();
}
