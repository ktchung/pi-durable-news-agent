// End-to-end check of the browser client: a faux dna-server-api with fixture search, the hub, and headless Chrome.
// Covers layout, cards and feedback, taste questions, tool rows into executions, the context bar, the model
// picker, keywords, text hygiene and data-cap coverage. Prints one PASS line per check.
//   npm run build -w dna-client-browser && node apps/dna-client-browser/tests/ui-faux.mjs   (HEADED=1 to watch)
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const app = resolve(import.meta.dirname, "..");
const root = resolve(app, "../..");
const shots = join(app, "test-results");
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "dna-ui-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => `dna_${randomBytes(32).toString("base64url")}`;
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
const children = new Set();
function run(script, args, env, cwd) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DNA_ENV_FILE: "none",
      DNA_LOG_DIR: join(tmp, "logs"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.log = () => log;
  return child;
}
async function waitHttp(url, child) {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(child.log());
    await sleep(100);
  }
  throw new Error(`${url} never came up`);
}
const fail = (msg) => {
  throw new Error(`FAIL ${msg}`);
};
const check = (ok, msg) => (ok ? console.log(`PASS ${msg}`) : fail(msg));

const tokens = { client: token(), cron: token() };
const [apiPort, hubPort] = [await freePort(), await freePort()];
const apiUrl = `http://127.0.0.1:${apiPort}`;
const api = run(
  join(root, "apps/dna-server-api/src/main.ts"),
  ["--port", String(apiPort)],
  {
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    DNA_FIXTURE_SET: "news",
    DNA_DATA_DIR: join(tmp, "data"),
    DNA_DEVICE_NAME: "test",
    DNA_CLIENT_TOKEN: tokens.client,
    DNA_CRON_TOKEN: tokens.cron,
  },
  join(root, "apps/dna-server-api"),
);
await waitHttp(`${apiUrl}/healthz`, api);
const hub = run(
  join(app, "hub/src/main.ts"),
  ["--port", String(hubPort)],
  { DNA_API_URL: apiUrl, DNA_CLIENT_TOKEN: tokens.client, DNA_TARGET: "local" },
  app,
);
const base = `http://localhost:${hubPort}`;
await waitHttp(`${base}/hub/healthz`, hub);

const call = async (method, path, body, tok = tokens.client) => {
  const res = await fetch(apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};
const started = await call("POST", "/v1/workflows/news-sweep", { requestId: "ui:1" }, tokens.cron);
for (let i = 0; i < 300; i++) {
  const s = await call("GET", `/v1/sweeps/${started.sweep.id}`);
  if (s.status === "completed") break;
  await sleep(100);
}
for (let i = 0; i < 100 && (await call("GET", "/v1/agent")).busy; i++) await sleep(100);

// Seed a known relationship in the isolated fixture database. Semantic classification is tested separately.
const fixtureCards = (await call("GET", "/v1/feed")).items;
const related = fixtureCards.filter((c) => !c.title.includes("pi-durable")).slice(0, 2);
check(related.length === 2, "two fixture developments are available for story UI checks");
const fixtureDb = new DatabaseSync(join(tmp, "data", "dna.sqlite"));
const storyId = related[0].storyId;
fixtureDb.exec("BEGIN IMMEDIATE");
fixtureDb
  .prepare("UPDATE stories SET title=? WHERE id=?")
  .run("Fixture story progression", storyId);
fixtureDb.prepare("DELETE FROM story_items WHERE item_id=?").run(related[1].itemId);
fixtureDb
  .prepare("UPDATE story_memberships SET story_id=? WHERE item_id=?")
  .run(storyId, related[1].itemId);
fixtureDb.prepare("INSERT INTO story_items VALUES (?, ?)").run(storyId, related[1].itemId);
fixtureDb.exec("COMMIT");
fixtureDb.close();

const browser = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on(
  "console",
  (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()),
);
const caps = new Set();
const collectCaps = async () =>
  (
    await page
      .locator("[data-cap]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-cap")))
  ).forEach((c) => caps.add(c));
const BANNED = [/\u2014/, /\u2013/, /\u00b7/, /\u2022/, /\u2026/, / - /, /\.\.\./];
async function cleanText(where) {
  const text = await page.evaluate(() => document.body.innerText);
  const hit = BANNED.find((re) => re.test(text));
  check(
    !hit,
    `${where}: no em dash, en dash, middle dot, bullet, ellipsis, spaced hyphen or three dots${hit ? ` (found ${hit} near "${text.slice(Math.max(0, text.search(hit) - 40), text.search(hit) + 40)}")` : ""}`,
  );
}

try {
  await page.goto(base);
  await page.locator(".card").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".card").length >= 3);
  await page.locator('[data-role="agent"]').first().waitFor();
  await page.screenshot({ path: join(shots, "main.png") });

  // ---------------------------------------------------------------- feed
  const news = page.locator(".feed-list .card");
  const newsCount = await news.count();
  check(
    newsCount === 3 &&
      (await page.locator('[role="tab"][data-tab="news"]').getAttribute("aria-selected")) ===
        "true",
    "3 story cards render from 4 developments in the News tab",
  );
  const heights = await news.evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  check(
    new Set(heights).size === 1,
    `every card has one height (${[...new Set(heights)].join(", ")} px)`,
  );
  const rails = await page.locator(".feed-row").evaluateAll((rows) =>
    rows.map((r) => ({
      railTop: Math.round(r.querySelector(".rail").getBoundingClientRect().top),
      cardTop: Math.round(r.querySelector(".card").getBoundingClientRect().top),
      time: r.querySelector(".rail-time")?.textContent?.trim() ?? "",
      icon: !!r.querySelector(".rail-node svg"),
      keyword: r.querySelector(".rail-keyword")?.textContent?.trim() ?? "",
    })),
  );
  check(
    rails.length === 3 &&
      rails.every((r) => r.railTop === r.cardTop && r.time && r.icon && r.keyword),
    `each card has a rail of time, icon and keyword aligned with it (${rails.map((r) => r.keyword).join(", ")})`,
  );
  const media = await news.first().locator("a.card-media");
  check(
    (await media.getAttribute("target")) === "_blank" &&
      (await media.getAttribute("href")) ===
        (await news.first().locator('a[aria-label="Open the source"]').getAttribute("href")),
    "the card image opens the source in a new tab",
  );
  const ids = await news.evaluateAll((els) =>
    els.map((e) => Number(e.getAttribute("data-card-id"))),
  );
  const boxes = await news.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  check(
    ids.every((id, i) => i === 0 || id < ids[i - 1]) &&
      boxes.every((y, i) => i === 0 || y > boxes[i - 1]),
    "news runs newest first, the latest card on top",
  );
  const ranked = await page.locator('[data-testid="hfs"]').evaluateAll((els) =>
    els.map((el) =>
      [...el.querySelectorAll(".hfs-chip")].map((c) => ({
        score: Number(c.getAttribute("data-score")),
        primary: c.classList.contains("primary"),
      })),
    ),
  );
  check(
    ranked.length === 3 &&
      ranked.every(
        (chips) =>
          chips.length === 3 &&
          chips[0].primary &&
          chips.every((c, i) => i === 0 || c.score <= chips[i - 1].score),
      ),
    "H/F/S pills are ranked with the primary first",
  );
  const comps = await page
    .locator(".card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-component")));
  check(
    comps.includes("signal_alert") && comps.includes("thread_pulse"),
    `generative components render (${[...new Set(comps)].join(", ")})`,
  );

  const before = await call("GET", "/v1/keywords?kind=topic");
  const durable = page.locator(".feed-list .card", { hasText: "pi-durable" }).first();
  await durable.getByRole("button", { name: "Show me more" }).click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-card-id="${id}"] [data-cap="feedback.more"]`)
        ?.classList.contains("on"),
    await durable.getAttribute("data-card-id"),
  );
  const after = await call("GET", "/v1/keywords?kind=topic");
  const moved = after.filter((k) => k.weight > (before.find((b) => b.id === k.id)?.weight ?? 9));
  check(
    moved.length > 0,
    `Show me more raised a topic weight (${moved.map((k) => k.term).join(", ")})`,
  );
  await durable.getByRole("button", { name: "Label Signal" }).click();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-card-id="${id}"] .fb.tag.signal`)?.classList.contains("on"),
    await durable.getAttribute("data-card-id"),
  );
  check(true, "labeling a card Signal shows as pressed");
  const toast = await page.locator(".toast").boundingBox();
  check(toast && toast.y < 150, `notifications show at the top (y ${Math.round(toast?.y ?? -1)})`);

  // ---------------------------------------------------------------- timelines
  const chips = page.locator('.feed-list [data-cap="timelines.read"]');
  check(
    (await chips.count()) === 1 &&
      (await chips.allInnerTexts())
        .map((t) => t.replace(/\s+/g, " ").trim())
        .sort()
        .join(" | ") === "Timeline 2/2",
    "one story card links both developments in its timeline",
  );
  await page.getByRole("button", { name: "Open 2 story sources" }).click();
  await page.getByRole("heading", { name: "Story sources" }).waitFor();
  check(
    (await page.locator(".card-detail .finding a").count()) === 2,
    "story sources expand with both original article links",
  );
  await page.locator(".card-detail").getByRole("button", { name: "Close", exact: true }).click();
  await chips.first().click();
  await page.locator("[data-timeline] .card").nth(1).waitFor();
  const tab = page.locator('[data-tab^="timeline-"]');
  check(
    (await tab.innerText()).includes("Fixture story progression") &&
      (await page.locator('[data-timeline] [data-cap="timelines.read"]').allInnerTexts())
        .map((t) => t.replace(/\s+/g, " ").trim())
        .join(" | ") === "Timeline 1/2 | Timeline 2/2",
    "the chip opens a tab named after the timeline with its cards in order",
  );
  await page.screenshot({ path: join(shots, "timeline.png") });
  await page.reload();
  await page.locator("[data-timeline] .card").first().waitFor();
  check(true, "the open timeline tab survives a reload");
  await page.getByRole("button", { name: /Close the .* timeline/ }).click();
  await page.locator('[data-tab^="timeline-"]').waitFor({ state: "detached" });
  check(
    (await page.locator('[data-tab="news"]').getAttribute("aria-selected")) === "true",
    "closing the timeline tab returns to News",
  );
  await page.locator(".feed-list .card").first().waitFor();

  // ---------------------------------------------------------------- card polish
  const firstCard = page.locator(".feed-list .card").first();
  const chipFill = await firstCard.locator(".hfs-chip").evaluateAll((els) =>
    els.map((e) => ({
      score: e.getAttribute("data-score"),
      style: e.getAttribute("style") ?? "",
    })),
  );
  check(
    chipFill.length === 3 && chipFill.every((c) => c.style.includes(`--fill: ${c.score}%`)),
    "each H/F/S chip fills to its score",
  );
  const order = await page.locator(".feed-list .card").evaluateAll((cards) =>
    cards.map((card) => ({
      chips: [...card.querySelectorAll(".hfs-chip")].map((c) => c.getAttribute("data-category")),
      labels: [...card.querySelectorAll(".fb.tag")].map((b) =>
        ["hype", "facts", "signal"].find((c) => b.classList.contains(c)),
      ),
    })),
  );
  check(
    order.every((o) => o.chips.join() === o.labels.join()),
    "label buttons follow each card's ranked chip order",
  );
  await firstCard.getByRole("button", { name: "Reference in chat" }).click();
  const draftText = await page.getByLabel("Message the agent").inputValue();
  check(
    /^card \d+ ".+" $/.test(draftText),
    `the to-chat button drops the card id and title into the chat (${draftText.trim()})`,
  );
  await page.getByLabel("Message the agent").fill("");
  const [opened] = await Promise.all([
    page.context().waitForEvent("page"),
    firstCard.locator(".card-title").first().click(),
  ]);
  check(
    opened.url() !== "about:blank" || (await opened.evaluate(() => location.href)) !== "",
    "clicking a title opens the article in a new tab",
  );
  await opened.close();

  // ---------------------------------------------------------------- top bar and agent controls
  for (const name of ["Executions", "Settings", "News", "Agent"])
    check(
      (await page.locator(".topbar .bar-button", { hasText: name }).count()) === 1,
      `the top bar button ${name} has a text label`,
    );
  check(
    (await page.getByTestId("device").innerText()).trim().length > 0,
    `the top bar names the device (${(await page.getByTestId("device").innerText()).trim()})`,
  );
  const spendStat = page.locator('.topbar [data-cap="usage"]');
  check(
    /^\$\d/.test((await spendStat.innerText()).trim()) &&
      /^Total spend: model \$.*, jev \$.*, images \$/.test(
        (await spendStat.getAttribute("title")) ?? "",
      ),
    "the top bar shows total spend, with model, jev and images on hover",
  );
  const initialSchedule = await call("GET", "/v1/schedule");
  const scheduleButton = page.getByRole("button", { name: "Edit sweep schedule" });
  const scheduleDialog = page.getByRole("dialog", { name: "Sweep schedule" });
  const schedulerStatus = page.getByTestId("scheduler-status");
  await scheduleButton.click();
  check(
    typeof initialSchedule.cronExpression === "string" &&
      (await scheduleDialog.getByTestId("saved-cron").innerText()).trim() ===
        initialSchedule.cronExpression &&
      (await scheduleDialog.getByLabel("Cron expression").inputValue()) ===
        initialSchedule.cronExpression,
    `the schedule dialog shows the saved cron (${initialSchedule.cronExpression})`,
  );
  await scheduleDialog.getByRole("button", { name: "Close" }).click();
  const cardsSelect = page.getByLabel("Cards per sweep");
  check((await cardsSelect.inputValue()) === "7", "the top bar shows 7 cards per sweep");
  await cardsSelect.selectOption("10");
  await sleep(400);
  check(
    (await call("GET", "/v1/schedule")).cardsPerSweep === 10,
    "picking cards per sweep reaches the API",
  );
  await cardsSelect.selectOption("7");
  await scheduleButton.click();
  await scheduleDialog.getByRole("button", { name: "Off", exact: true }).click();
  await schedulerStatus.filter({ hasText: "Scheduled sweeps off" }).waitFor();
  check(
    (await call("GET", "/v1/schedule")).cronExpression === null,
    "turning the schedule off reaches the API and the status says so",
  );
  await scheduleDialog.getByLabel("Cron expression").fill("*/5 * * * *");
  await scheduleDialog.getByRole("button", { name: "Save" }).click();
  await scheduleDialog.getByRole("button", { name: "Save" }).filter({ hasText: "Save" }).waitFor();
  check(
    (await call("GET", "/v1/schedule")).cronExpression === "*/5 * * * *" &&
      !(await schedulerStatus.innerText()).includes("Scheduled sweeps off"),
    "saving a cron expression in the dialog reaches the API and turns sweeps back on",
  );
  await scheduleDialog.getByLabel("Cron expression").fill(initialSchedule.cronExpression);
  await scheduleDialog.getByRole("button", { name: "Save" }).click();
  await scheduleDialog.getByRole("button", { name: "Close" }).click();
  check(
    (await page.locator(".model-button").count()) === 0 &&
      (await page.locator(".context-line").count()) === 0,
    "model and context stay hidden until the Model toggle is on",
  );
  const modelToggle = page.locator(".composer .model-toggle");
  const busyBox = await page.locator(".when-busy").boundingBox();
  const toggleBox = await modelToggle.boundingBox();
  check(
    toggleBox.x >= busyBox.x + busyBox.width &&
      Math.abs(toggleBox.y + toggleBox.height / 2 - (busyBox.y + busyBox.height / 2)) < 6,
    "the Model toggle sits right of When busy",
  );
  await modelToggle.click();
  await page.locator(".composer .model-button").waitFor();
  check(
    (await modelToggle.getAttribute("aria-pressed")) === "true" &&
      (await page.getByLabel("Thinking level", { exact: true }).count()) === 1,
    "the Model toggle shows model and thinking above the composer buttons",
  );
  const contextLine = await page.locator(".composer .context-line").boundingBox();
  const composerBox = await page.locator(".composer textarea").boundingBox();
  check(
    contextLine.height <= 40 &&
      contextLine.y < composerBox.y &&
      (await page.locator(".context-line .context-marker").count()) === 2,
    `with Model on, context is one line above the message box with two ticks (${Math.round(contextLine.height)}px)`,
  );
  const modelRow = await page.locator(".composer .model-row").first().boundingBox();
  const ctxAfter = await page.locator(".composer .context-line").boundingBox();
  check(
    modelRow.y >= ctxAfter.y + ctxAfter.height - 1 &&
      modelRow.y - (ctxAfter.y + ctxAfter.height) < 16,
    "model and context sit together: the model row right under the context line",
  );
  const quickModel = page.getByLabel("Quick tasks model");
  check(
    (await quickModel.inputValue()) === "anthropic/claude-haiku-5.5" &&
      (await page.getByLabel("Quick tasks thinking level").inputValue()) === "off",
    "the Model panel shows the quick tasks model (Haiku 5.5, thinking off)",
  );
  await quickModel.selectOption("openai/gpt-6-luna");
  await sleep(400);
  check(
    (await call("GET", "/v1/agent")).quick.model === "openai/gpt-6-luna",
    "picking a quick tasks model reaches the API",
  );
  const quickBox = await page.getByRole("group", { name: "Quick tasks" }).boundingBox();
  const deepBox = await page.getByRole("group", { name: "Deep research" }).boundingBox();
  check(
    deepBox.y > quickBox.y &&
      (await page.getByLabel("Deep research model").inputValue()) ===
        "anthropic/claude-haiku-5.5" &&
      (await page.getByLabel("Deep research thinking level").inputValue()) === "xhigh" &&
      (await page.getByLabel("Deep research count").inputValue()) === "1",
    "the Deep research row sits under Quick tasks (Haiku 5.5, thinking xhigh, count 1)",
  );
  await page.getByLabel("Deep research count").selectOption("5");
  await page.getByLabel("Deep research thinking level").selectOption("high");
  await sleep(400);
  const deepState = (await call("GET", "/v1/agent")).deepResearch;
  check(
    deepState.count === 5 && deepState.thinkingLevel === "high",
    "picking a deep research count and thinking level reaches the API",
  );
  check((await page.locator(".brand-mark svg").count()) === 1, "the logo is the Signal icon");
  await collectCaps();

  // ---------------------------------------------------------------- agent: chat, sides, taste question
  const composer = page.getByLabel("Message the agent");
  await composer.fill("What did you find?");
  await composer.press("Enter");
  await page.locator('[data-role="user"]', { hasText: "What did you find?" }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="agent"]')].some((e) =>
      e.textContent?.includes("Got it"),
    ),
  );
  const chat = await page.getByTestId("chat").boundingBox();
  const user = await page.locator('[data-role="user"]').last().boundingBox();
  const agentMsg = await page.locator('[data-role="agent"]').last().boundingBox();
  check(
    Math.abs(user.x + user.width - (chat.x + chat.width)) < 4 && Math.abs(agentMsg.x - chat.x) < 4,
    "user messages sit right and agent messages left",
  );
  check(
    (await page.locator('[data-chip="sweep"]').count()) === 1 &&
      (await page.locator('[data-entry="dna.sweep-progress"]').count()) >= 4,
    "the cron prompt renders as a Scheduled sweep chip with progress lines",
  );

  const itemId = (await call("GET", `/v1/cards/${await durable.getAttribute("data-card-id")}`)).item
    .id;
  await composer.fill(
    `FAUX_CALL ask_taste {"item_id": ${itemId}, "question": "Is this hype, facts or signal for you?"}`,
  );
  await composer.press("Enter");
  const question = page.locator(".taste-question");
  await question.waitFor();
  await collectCaps();
  await question.getByRole("button", { name: "Facts" }).click();
  await question.getByRole("button", { name: "Answer" }).click();
  await page.locator('[data-chip="taste"]').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="agent"]')].some((e) =>
      e.textContent?.includes("Noted"),
    ),
  );
  const answered = (await call("GET", "/v1/taste-questions?status=answered"))[0];
  check(
    answered?.answerLabels.includes("facts") && (await question.count()) === 0,
    "answering a taste question posts it and the chat acknowledges it",
  );

  // ---------------------------------------------------------------- search, open_tab, highlight_item
  const searchBox = page.getByLabel("Search news");
  await searchBox.fill("durable");
  await page.locator('[data-tab="search-durable"]').waitFor();
  await page.locator("[data-search] .card").first().waitFor();
  const matches = (await call("GET", "/v1/feed/search?q=durable")).length;
  check(
    matches >= 1 && (await page.locator("[data-search] .card").count()) === matches,
    `the search box opens a search tab with the matching news (${matches})`,
  );
  await searchBox.fill("durable agents");
  await page.locator('[data-tab="search-durable agents"]').waitFor();
  check(
    (await page.locator('[data-tab^="search-"]').count()) === 1,
    "typing edits the open search tab instead of opening another",
  );
  await collectCaps();
  await page.getByRole("button", { name: "Close the durable agents search" }).click();
  await page.locator('[data-tab^="search-"]').waitFor({ state: "detached" });
  const site = new URL(
    (await call("GET", `/v1/cards/${await durable.getAttribute("data-card-id")}`)).item.url,
  ).hostname;
  await composer.fill(`FAUX_CALL open_tab {"by": "url", "value": "${site}"}`);
  await composer.press("Enter");
  await page.locator(`[data-tab="url-${site}"]`).waitFor();
  await page.locator("[data-search] .card").first().waitFor();
  check(
    (await page.locator(`[data-tab="url-${site}"] [role="tab"]`).getAttribute("aria-selected")) ===
      "true",
    "the agent's open_tab opens a url tab in the browser",
  );
  const when = (c) => Date.parse(c.publishedAt ?? c.createdAt);
  const oldest = (await call("GET", "/v1/feed?limit=200")).items.sort(
    (a, b) => when(a) - when(b),
  )[0].id;
  await composer.fill(`FAUX_CALL highlight_item {"card_id": ${oldest}}`);
  await composer.press("Enter");
  const lit = page.locator(`.feed-list .feed-row.highlight[data-row="${oldest}"]`);
  await lit.waitFor();
  await sleep(1200);
  const box = await lit.boundingBox();
  const list = await page.locator(".feed-list .bottom-scroll").boundingBox();
  check(
    (await page.locator('[data-tab="news"]').getAttribute("aria-selected")) === "true" &&
      box.y + box.height > list.y &&
      box.y < list.y + list.height,
    "highlight_item switches to News, scrolls to the card and highlights it",
  );
  await page.screenshot({ path: join(shots, "highlight.png") });

  // ---------------------------------------------------------------- thumbs down hides a card from News
  const shownInNews = async () => Number(await page.locator(`[data-tab="news"] small`).innerText());
  const shownBefore = await shownInNews();
  const doomed = page
    .locator(".feed-list .feed-row:not(.highlight) .card:not(:has(.timeline-chip))")
    .last();
  const doomedId = await doomed.getAttribute("data-card-id");
  await doomed.getByRole("button", { name: "Show me less" }).click();
  await page.locator(`.feed-list [data-card-id="${doomedId}"]`).waitFor({ state: "detached" });
  await page.locator(".toast", { hasText: "Hidden from News" }).waitFor();
  check(
    (await shownInNews()) === shownBefore - 1 &&
      (await call("GET", `/v1/cards/${doomedId}`)).card.feedback.signal === "less",
    "a thumbs down hides the card from News and records show me less",
  );

  // ---------------------------------------------------------------- tool row into executions
  await page.waitForFunction(() =>
    document.querySelector('[data-tool="present_news"][data-status="done"]:not([disabled])'),
  );
  await page.locator('[data-tool="present_news"][data-status="done"]').first().click();
  await page.locator("[data-tool-detail]").waitFor();
  const field = async (f) =>
    (await page.locator(`[data-tool-detail] [data-field="${f}"]`).textContent())?.trim() ?? "";
  const [duration, startedAt, endedAt, tokensText, cost] = [
    await field("duration"),
    await field("started"),
    await field("ended"),
    await field("tokens"),
    await field("cost"),
  ];
  check(
    /\d+(ms|\.\ds)/.test(duration) &&
      /\d\d:\d\d:\d\d/.test(startedAt) &&
      /\d\d:\d\d:\d\d/.test(endedAt) &&
      /\d+k? in/.test(tokensText) &&
      /\$/.test(cost),
    `a tool row opens executions with duration ${duration}, start ${startedAt}, end ${endedAt}, tokens ${tokensText}, cost ${cost}`,
  );
  await page.getByRole("button", { name: "Open the run" }).click();
  await page.locator("[data-run] .generation").first().waitFor();
  check(
    (await page.locator("[data-run] .generation").count()) >= 5,
    "the run tree lists every generation",
  );
  await collectCaps();
  const sweepRow = page.locator(".exec-tree .list-row", { hasText: "Sweep 1" }).first();
  check(
    (await page.locator(".exec-list .tabs").count()) === 0 &&
      (await page.locator(".exec-tree .list-row", { hasText: "Chat" }).count()) >= 1,
    "Executions is one list: sweeps and chats together, no Runs and Sweeps tabs",
  );
  await sweepRow.locator(".row-main").click();
  await page.locator("[data-sweep]").waitFor();
  await page.locator("[data-run] .generation").first().waitFor();
  check(
    (await page.locator(".audit-step.missing").count()) === 0 &&
      (await page.locator(".audit-step").count()) > 3,
    "a sweep shows its phases, a clean audit and the run it started, together",
  );
  await sweepRow.getByRole("button", { name: "Open sweep 1" }).click();
  await page.locator('[data-exec-tool="run_news_sweep"]').waitFor();
  await page.locator(".exec-children .exec-leaf", { hasText: "news-researcher" }).first().waitFor();
  check(
    (await page.locator(".exec-children [data-exec-tool]").count()) >= 5,
    "a sweep opens into its tool calls and its researcher runs",
  );
  await page.locator('[data-exec-tool="complete_sweep"]').click();
  await page.locator("[data-tool-detail]").waitFor();
  check(true, "a tool call in the tree opens its detail");
  await sweepRow.locator(".row-main").click();
  await page.locator("[data-sweep]").waitFor();
  const logPills = page.locator(".logs .pill");
  check(
    (await logPills.count()) === 8 && (await page.locator(".logs .pill.on").count()) === 8,
    "logs start with every app and level selected as pills",
  );
  await page.locator(".log-line").first().waitFor();
  const payloadButton = page.locator(".log-line button[aria-label^='Show the']").first();
  await payloadButton.click();
  await page.locator(".json-modal .json-view .json-key").first().waitFor();
  check(true, "a log line's payload opens as highlighted JSON in a modal");
  await page.keyboard.press("Escape");
  await page.locator(".json-modal").waitFor({ state: "detached" });
  await page.locator(".logs .pill", { hasText: "debug" }).click();
  check((await page.locator(".logs .pill.on").count()) === 7, "a level pill filters the logs down");
  await collectCaps();
  await page.screenshot({ path: join(shots, "executions.png") });
  await cleanText("executions");
  await page.getByRole("button", { name: "Close executions" }).click();

  // ---------------------------------------------------------------- context bar
  await call("PATCH", "/v1/agent/compaction", { background: 60_000, force: 300_000 });
  await page.reload();
  await page.locator('[data-marker="background"][aria-valuenow="60000"]').waitFor();
  const bar = await page.locator(".context-bar").boundingBox();
  const windowTokens = (await call("GET", "/v1/agent/compaction")).window;
  const dragTo = async (marker, tokensAt) => {
    const m = await page.locator(`[data-marker="${marker}"]`).boundingBox();
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + (bar.width * tokensAt) / windowTokens, m.y + m.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await sleep(400);
  };
  await dragTo("force", 200_000);
  await dragTo("background", 100_000);
  const saved = await call("GET", "/v1/agent/compaction");
  const tolerance = windowTokens / bar.width + 512;
  check(
    Math.abs(saved.background - 100_000) <= tolerance &&
      Math.abs(saved.force - 200_000) <= tolerance,
    `dragging the context bar sets about 100k and 200k (${saved.background}, ${saved.force})`,
  );
  await page.reload();
  await page.locator(`[data-marker="background"][aria-valuenow="${saved.background}"]`).waitFor();
  check(
    (await page.locator('[data-marker="force"]').getAttribute("aria-valuenow")) ===
      String(saved.force),
    "the context points survive a reload",
  );
  const tickLabel = (m) => page.locator(`[data-marker="${m}"] .tick-label`);
  const [bgText, forceText] = [
    await tickLabel("background").innerText(),
    await tickLabel("force").innerText(),
  ];
  const [bgBox, forceBox] = [
    await tickLabel("background").boundingBox(),
    await tickLabel("force").boundingBox(),
  ];
  check(
    bgText === "100k" && forceText === "200k" && bgBox.x + bgBox.width <= forceBox.x,
    `each tick shows its token count above it (${bgText}, ${forceText}), side by side without overlap`,
  );
  await page.getByRole("button", { name: "Compaction details" }).click();
  await page.getByRole("dialog", { name: "Context compaction" }).waitFor();
  await collectCaps();
  await page
    .getByRole("dialog", { name: "Context compaction" })
    .getByRole("button", { name: "Close" })
    .click();

  // ---------------------------------------------------------------- model picker
  check(
    (await page.locator(".model-button").textContent()).includes("Faux Haiku"),
    "the agent starts on the device default model",
  );
  await page.getByRole("button", { name: "Choose a model" }).click();
  const { defaultModel } = await call("GET", "/v1/info");
  const badges = page.locator(".model-list .badge");
  check(
    (await badges.count()) === 1 &&
      (await page.locator(`[data-model="${defaultModel}"] .badge`).textContent()) === "Default",
    `the model picker marks only the server's default (${defaultModel}) as Default`,
  );
  const haiku = page.locator('[data-model="anthropic/claude-haiku-5.5"]');
  await haiku.click();
  await page.waitForFunction(() =>
    document.querySelector(".model-button")?.textContent?.includes("Claude Haiku 5.5"),
  );
  check(
    (await call("GET", "/v1/agent")).model === "anthropic/claude-haiku-5.5",
    "the model picker switches the agent's model",
  );

  // ---------------------------------------------------------------- settings: keywords CRUD
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsBox = await page.getByRole("dialog", { name: "Settings" }).boundingBox();
  const viewport = page.viewportSize();
  check(
    settingsBox.width > viewport.width * 0.55 &&
      Math.abs(settingsBox.x + settingsBox.width / 2 - viewport.width / 2) < 4,
    `Settings opens as a full, centered modal (${Math.round(settingsBox.width)}px wide)`,
  );
  await page.getByLabel("Add a topic keyword").fill("agent memory");
  await page.getByRole("button", { name: "Add topic keyword" }).click();
  const row = page.locator('[data-keyword="agent memory"]');
  await row.waitFor();
  await row.locator('input[type="range"]').evaluate((el) => {
    el.value = "1.5";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-keyword="agent memory"] .kw-weight')?.textContent === "1.50",
  );
  await row.getByRole("button", { name: "Turn off agent memory" }).click();
  await page.locator('[data-keyword="agent memory"].off').waitFor();
  const kw = (await call("GET", "/v1/keywords?kind=topic")).find((k) => k.term === "agent memory");
  check(
    kw?.weight === 1.5 && kw.enabled === false,
    "keywords: add, weight and toggle reach the API",
  );
  await page
    .locator('[data-keyword="agent memory"]')
    .getByRole("button", { name: "Remove agent memory" })
    .click();
  await page.locator('[data-keyword="agent memory"]').waitFor({ state: "detached" });
  check(
    !(await call("GET", "/v1/keywords?kind=topic")).some((k) => k.term === "agent memory"),
    "keywords: remove reaches the API",
  );
  await composer.fill('FAUX_CALL edit_keyword {"action": "add", "term": "agent queues"}');
  await composer.press("Enter");
  await page.locator('[data-keyword="agent queues"]').waitFor();
  check(true, "the agent's keyword edits show up live in Settings");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const simonWeight = page.getByLabel("Weight of Simon Willison");
  await simonWeight.evaluate((el) => {
    el.value = "1.5";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(400);
  check(
    (await call("GET", "/v1/sources")).find((x) => x.name === "Simon Willison")?.weight === 1.5,
    "a source's weight slider reaches the API",
  );
  await collectCaps();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const searchDoc = page.locator('[data-tool-doc="search_web"]');
  await searchDoc.waitFor();
  await searchDoc.locator("summary").first().click();
  await searchDoc.locator(".tool-definition summary").click();
  check(
    (await searchDoc.locator(".param-table tr").count()) === 3 &&
      (await searchDoc.locator(".req").count()) === 1 &&
      (await searchDoc.innerText()).includes("one line per hit") &&
      (await searchDoc.locator(".json-view .json-key").count()) > 3,
    "the Tools tab shows each tool's params, return and a highlighted definition",
  );
  await page.getByRole("button", { name: "Taste", exact: true }).click();
  await collectCaps();
  await page.screenshot({ path: join(shots, "settings.png") });
  await cleanText("settings");
  await page.getByRole("button", { name: "Close settings" }).click();

  // ---------------------------------------------------------------- layout
  await collectCaps();
  await cleanText("main view");
  await page.getByRole("button", { name: "Toggle the news column" }).click();
  check((await page.locator('[data-col="feed"]').count()) === 0, "the news column collapses");
  await page.reload();
  await page.locator('[data-col="agent"]').waitFor();
  check(
    (await page.locator('[data-col="feed"]').count()) === 0,
    "the collapsed column stays collapsed after a reload",
  );
  await page.getByRole("button", { name: "Toggle the agent column" }).click();
  await page.locator(".toast", { hasText: "Keep one column open" }).waitFor();
  check(
    (await page.locator('[data-col="agent"]').count()) === 1,
    "the last open column cannot hide",
  );
  await page.getByRole("button", { name: "Toggle the news column" }).click();
  await page.getByRole("button", { name: "Toggle the agent column" }).click();
  check(
    (await page.locator('[data-col="agent"]').count()) === 0 &&
      (await page.locator('[data-col="feed"]').count()) === 1,
    "the agent column collapses too",
  );
  await page.reload();
  await page.locator('[data-col="feed"]').waitFor();
  check(
    (await page.locator('[data-col="agent"]').count()) === 0,
    "the agent column stays collapsed after a reload",
  );
  await page.getByRole("button", { name: "Toggle the agent column" }).click();
  await page.locator('[data-col="agent"]').waitFor();

  // ---------------------------------------------------------------- phone: one pane at a time
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await phoneContext.newPage();
  phone.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
  const overflow = () =>
    phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const visible = (sel) =>
    phone
      .locator(sel)
      .evaluate((e) => getComputedStyle(e).visibility === "visible" && !e.closest("[inert]"));
  await phone.goto(base);
  await phone.locator(".feed-list .card").first().waitFor();
  await phone.waitForTimeout(300);
  const cardWidth = await phone
    .locator(".feed-list .card")
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  check(
    (await overflow()) <= 0 && cardWidth >= 340,
    `a 390 px phone shows News full width with no sideways scroll (card ${Math.round(cardWidth)} px)`,
  );
  check(
    (await visible('[data-col="feed"]')) &&
      !(await visible('[data-col="agent"]')) &&
      (await phone.locator(".resize-handle").count()) === 0,
    "a phone shows one pane, News first, with no resize handle",
  );
  await phone.locator('.feed-list [aria-label="Card details"]').first().click();
  await phone.locator(".card-detail").waitFor();
  check(true, "a card's controls can be tapped on a phone");
  await phone.locator('.card-detail [aria-label="Close"]').click();
  await phone.locator('.mobile-tab[data-pane="agent"]').click();
  check(
    (await visible('[data-col="agent"]')) &&
      !(await visible('[data-col="feed"]')) &&
      (await phone.locator(".composer textarea").isVisible()) &&
      (await overflow()) <= 0,
    "the bottom bar switches to the agent, composer in view",
  );
  await phone.locator('.mobile-tab[data-pane="feed"]').click();
  await phone.locator('.feed-list [aria-label="Reference in chat"]').first().click();
  await phone.waitForFunction(
    () => document.activeElement === document.querySelector(".composer textarea"),
  );
  check(await visible('[data-col="agent"]'), "Reference in chat switches a phone to the agent");
  await phone.getByRole("button", { name: "Executions" }).click();
  await phone.locator(".exec-tree .row-main").first().click();
  await phone.locator(".exec-back").waitFor();
  check(
    !(await phone.locator(".exec-list").isVisible()) && (await overflow()) <= 0,
    "executions on a phone open one at a time",
  );
  await phone.locator(".exec-back").click();
  await phone.locator(".exec-list").waitFor();
  await phoneContext.close();

  // ---------------------------------------------------------------- capabilities
  const { CAPABILITY_IDS } = await import(
    join(root, "apps/shared/packages/dna-sdk/src/capabilities.ts")
  );
  const missing = CAPABILITY_IDS.filter((id) => !caps.has(id));
  check(
    missing.length === 0,
    `every capability has a data-cap control${missing.length ? ` (missing ${missing.join(", ")})` : ""}`,
  );
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("ALL PASS");
} catch (error) {
  await page.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  console.error(error.message);
  console.error(`api log tail:\n${api.log().slice(-2000)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const child of children) child.kill("SIGTERM");
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
