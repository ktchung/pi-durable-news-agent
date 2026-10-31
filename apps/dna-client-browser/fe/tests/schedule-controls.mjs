// Isolated real Vue/store + Chromium check. No backend, credentials, or sweeps.
// Run from repository root with Node 24 and PLAYWRIGHT_BROWSERS_PATH set if needed.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { port: 0 },
  plugins: [
    {
      name: "schedule-controls-test",
      resolveId(id) {
        if (id === "/schedule-controls-test.js") return id;
      },
      load(id) {
        if (id !== "/schedule-controls-test.js") return;
        return `
        import { createApp, h } from 'vue';
        import TopBar from '/src/components/TopBar.vue';
        import * as store from '/src/client/store.ts';
        import '/src/styles/tokens.css';
        import '/src/styles/app.css';
        window.fixture = store;
        createApp({ render: () => h(TopBar) }).mount('#app');
      `;
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.clock.install({ time: new Date("2026-10-29T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-29T12:00:00Z"));
  const errors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("**/schedule-controls-test.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="app"></div><script type="module" src="/schedule-controls-test.js"></script>',
    }),
  );
  await page.goto(`${server.resolvedUrls.local[0]}schedule-controls-test.html`);
  await page.waitForFunction(() => !!window.fixture);
  await page.evaluate(() => {
    const { info, feed, connection, api } = window.fixture;
    connection.value = "live";
    info.value = { nextSweepAt: new Date(Date.now() + 30_000).toISOString() };
    window.schedule = {
      everyMinutes: 480,
      cardsPerSweep: 7,
      presets: [1, 5, 60],
      tickMinutes: 1,
      cronExpression: "0 */8 * * *",
      timezone: "Asia/Shanghai",
      schedulerStatus: "waiting",
      nextScheduledAt: "2026-11-01T00:00:00.000Z",
      nextSweepAt: new Date(Date.now() + 30_000).toISOString(),
    };
    feed.apply({ type: "agent.state", state: { busy: false, schedule: window.schedule } });
    window.saves = [];
    window.cards = [];
    api.setCronSchedule = (cronExpression, timezone) => {
      window.saves.push({ cronExpression, timezone });
      return new Promise((resolve, reject) => {
        window.saveReply = (failure) => {
          if (failure) return reject(new Error(failure));
          window.schedule = {
            ...window.schedule,
            cronExpression,
            timezone,
            // The server response, not the submitted draft, determines rendered state.
            nextScheduledAt: "2026-11-02T00:00:00.000Z",
            schedulerStatus: "waiting",
            nextSweepAt: undefined,
          };
          resolve(window.schedule);
        };
      });
    };
    api.setCardsPerSweep = async (cardsPerSweep) => {
      window.cards.push(cardsPerSweep);
      return (window.schedule = { ...window.schedule, cardsPerSweep });
    };
  });
  const status = page.getByTestId("scheduler-status");
  await expect(status).toHaveText("Waiting for ticker");
  await expect(status).not.toContainText("next sweep in");
  await page.getByRole("button", { name: "Edit sweep schedule", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sweep schedule", exact: true });
  const cron = dialog.getByRole("textbox", { name: "Cron expression", exact: true });
  const timezone = dialog.getByRole("textbox", { name: "Timezone", exact: true });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(cron).toHaveValue("0 */8 * * *");
  await expect(timezone).toHaveValue("Asia/Shanghai");
  await expect(save).toBeDisabled();
  await expect(dialog).toContainText("0 */8 * * *");
  await expect(dialog.getByTestId("configured-next")).toContainText("08:00");
  await expect(dialog).toContainText("Configured time only");
  console.log(
    "PASS default eight-hour cron, server timezone, local configured time, waiting without stale info fallback",
  );

  await cron.fill("15 6 * * 1-5");
  await timezone.fill("Europe/London");
  await save.click();
  await expect(dialog.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await expect(cron).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.saves), [
    { cronExpression: "15 6 * * 1-5", timezone: "Europe/London" },
  ]);
  await expect(dialog.getByTestId("saved-cron")).toHaveText("0 */8 * * *");
  await page.evaluate(() => window.saveReply());
  await expect(dialog.getByTestId("saved-cron")).toHaveText("15 6 * * 1-5");
  await expect(save).toBeDisabled();
  await expect(dialog.getByTestId("configured-next")).toContainText("Nov 2");

  await cron.fill("99 25 * * *");
  await save.click();
  await page.evaluate(() => window.saveReply("Invalid cron expression: hour out of range"));
  await expect(dialog.getByRole("alert")).toContainText("hour out of range");
  await expect(cron).toHaveValue("99 25 * * *");
  await expect(dialog.getByTestId("saved-cron")).toHaveText("15 6 * * 1-5");
  await expect(save).toBeEnabled();
  await cron.fill("15 6 * * 1-5");
  await timezone.fill("Invalid/Timezone");
  await save.click();
  await page.evaluate(() => window.saveReply("Invalid schedule timezone"));
  await expect(dialog.getByRole("alert")).toContainText("Invalid schedule timezone");
  await expect(timezone).toHaveValue("Invalid/Timezone");
  console.log(
    "PASS exact cron/timezone payload, pending duplicate prevention, authoritative response, rejected draft retention",
  );

  await dialog.getByRole("button", { name: "Off", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.saves.at(-1)), {
    cronExpression: null,
    timezone: "Europe/London",
  });
  await page.evaluate(() => window.saveReply());
  await expect(status).toHaveText("Scheduled sweeps off");
  await expect(dialog.getByRole("button", { name: "Off", exact: true })).toBeDisabled();
  // Re-enable with a saved configuration, without running a sweep.
  await expect(cron).toHaveValue("0 */8 * * *");
  await save.click();
  await page.evaluate(() => window.saveReply());
  await expect(status).toHaveText("Waiting for ticker");
  assert.deepEqual(await page.evaluate(() => window.saves.at(-1)), {
    cronExpression: "0 */8 * * *",
    timezone: "Europe/London",
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("combobox", { name: "Cards per sweep", exact: true }).selectOption("15");
  assert.deepEqual(await page.evaluate(() => window.cards), [15]);
  console.log("PASS Off sends null, re-enable saves only, cards behavior retained");

  await page.evaluate(() => {
    const { feed } = window.fixture;
    window.schedule = {
      ...window.schedule,
      schedulerStatus: "stale",
      nextSweepAt: new Date(Date.now() + 60_000).toISOString(),
    };
    feed.apply({ type: "schedule", schedule: window.schedule });
  });
  await expect(status).toHaveText("Ticker stale · not running");
  await page.evaluate(() => {
    const { feed } = window.fixture;
    window.schedule = {
      ...window.schedule,
      schedulerStatus: "running",
      lastTickAt: new Date().toISOString(),
      nextSweepAt: new Date(Date.now() + 60_000).toISOString(),
    };
    feed.apply({ type: "schedule", schedule: window.schedule });
  });
  await expect(status).toHaveText("Next sweep in 1:00");
  await page.evaluate(() => {
    window.fixture.now.value = Date.now() + 61_000;
  });
  await expect(status).toHaveText("Awaiting ticker update");
  await expect(status).not.toContainText("0:00");
  // No new SSE frame: only the store clock changes after the ticker stops.
  await page.evaluate(() => {
    window.fixture.now.value = Date.now() + 91_000;
  });
  await expect(status).toHaveText("Ticker stale · not running");
  await page.evaluate(() => {
    window.schedule = {
      ...window.schedule,
      lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      nextSweepAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    };
    window.fixture.feed.apply({ type: "schedule", schedule: window.schedule });
  });
  await expect(status).toHaveText("Ticker stale · not running");
  console.log(
    "PASS stale heartbeat never counts down; active countdown expires into awaiting update rather than zero forever",
  );

  // An older API must not be misrepresented as a confirmed running ticker.
  await page.evaluate(() => {
    const {
      cronExpression: _cron,
      schedulerStatus: _status,
      lastTickAt: _tick,
      timezone: _zone,
      ...legacy
    } = window.schedule;
    window.fixture.feed.apply({ type: "schedule", schedule: legacy });
  });
  await expect(status).toHaveText("Ticker status unavailable");
  await page.getByRole("button", { name: "Edit sweep schedule", exact: true }).click();
  await expect(cron).toHaveValue("0 */8 * * *");
  await expect(timezone).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit sweep schedule", exact: true }),
  ).toBeFocused();

  await page.evaluate(() => {
    window.schedule = {
      ...window.schedule,
      cronExpression: "0 */8 * * *",
      timezone: "Asia/Shanghai",
      schedulerStatus: "waiting",
      lastTickAt: undefined,
    };
    window.fixture.feed.apply({ type: "schedule", schedule: window.schedule });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Edit sweep schedule", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(cron).toBeVisible();
  await expect(save).toBeVisible();
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("dialog").getBoundingClientRect();
    const inputs = [...document.querySelectorAll("dialog input, dialog button")].map((el) =>
      el.getBoundingClientRect(),
    );
    return {
      width: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      dialog: { left: dialog.left, right: dialog.right },
      controlsFit: inputs.every((rect) => rect.left >= 0 && rect.right <= innerWidth),
    };
  });
  assert.ok(layout.pageWidth <= layout.width, JSON.stringify(layout));
  assert.ok(
    layout.dialog.left >= 0 && layout.dialog.right <= layout.width && layout.controlsFit,
    JSON.stringify(layout),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, []);
  if (process.env.SCHEDULE_UI_SCREENSHOT)
    await page.screenshot({ path: process.env.SCHEDULE_UI_SCREENSHOT });
  console.log(
    "PASS legacy unknown status, keyboard dialog/focus, 390px layout without overflow; zero backend requests or page errors",
  );
} finally {
  await browser?.close();
  await server.close();
}
