// startNewsSweep: the one method behind POST /v1/workflows/news-sweep, which only the cron token may call.
import { join } from "node:path";
import { loadPrompt } from "@dna/durable-agent";
import type { Sweep } from "@dna/sdk";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Deps } from "../deps.ts";
import { auditSweep } from "./audit.ts";

export interface StartSweepInput {
  trigger: Sweep["trigger"];
  requestId: string;
  /** A cron tick: start only when the schedule says a sweep is due. */
  scheduled?: boolean;
  /** This run's card limit; the reader's cards per sweep setting otherwise. */
  cards?: number;
}

export interface StartSweepResult {
  status: "accepted" | "replay" | "skipped" | "not_due";
  /** Every status but not_due has its sweep. */
  sweep?: Sweep;
  reason?: string;
  submissionId?: number;
}

/**
 * Close open sweeps that can no longer finish: the agent's run for its submission ended without complete_sweep (a
 * restart, an abort or a provider failure in the middle), or nothing came back for DNA_STALL_MINUTES. Otherwise one
 * stuck sweep skips every tick.
 */
export function closeStalledSweeps(
  deps: Pick<Deps, "store" | "log" | "config" | "bus">,
  now = Date.now(),
) {
  const { store, config } = deps;
  for (const open of store.sweeps.active()) {
    const run = open.submissionId ? store.telemetry.submissionRun(open.submissionId) : undefined;
    const ended = run && run.status !== "running" ? run.status : undefined;
    const timedOut = now - Date.parse(open.createdAt) > config.stallMinutes * 60_000;
    if (!ended && !timedOut) continue;
    closeStalled(
      deps,
      open.id,
      ended
        ? `The agent's run ended (${ended}) before complete_sweep`
        : `No result after ${config.stallMinutes} minutes`,
    );
  }
}

/**
 * A sweep queued behind a run that failed never starts: pi-durable keeps a queued input in the inbox until the next
 * submission, and every tick skips while the sweep is open. Withdraw it and close it so the next tick starts fresh.
 */
export async function withdrawStuckSweeps(
  deps: Pick<Deps, "store" | "log" | "bus">,
  queue: { mainId: number; withdraw(submissionId: number): Promise<string> },
) {
  const { store } = deps;
  const last = store.telemetry.lastRun(queue.mainId);
  if (last?.status !== "unanswered" || !last.endedAt) return;
  for (const open of store.sweeps.active()) {
    if (!open.submissionId || store.telemetry.submissionRun(open.submissionId)) continue;
    if (last.endedAt < Date.parse(open.createdAt)) continue;
    if ((await queue.withdraw(open.submissionId)) === "already_placed") continue;
    closeStalled(deps, open.id, "Queued behind an agent run that failed, so it was withdrawn");
  }
}

function closeStalled(deps: Pick<Deps, "store" | "log" | "bus">, sweepId: number, error: string) {
  const { store, log } = deps;
  store.sweeps.update(sweepId, { status: "stalled", error, endedAt: new Date().toISOString() });
  auditSweep(store, sweepId, log);
  log.error("sweep.stalled", { sweepId, error });
  deps.bus.publish({ type: "sweep", sweep: store.sweeps.get(sweepId)! });
}

export async function startNewsSweep(
  deps: Deps,
  main: Conversation,
  ctx: Context,
  input: StartSweepInput,
): Promise<StartSweepResult> {
  const { store, log, config } = deps;
  const now = Date.now();
  if (input.trigger === "cron" && input.scheduled === true) {
    deps.schedule.recordTick(now);
    deps.bus.publish({ type: "schedule", schedule: deps.schedule.state(now) });
  }
  const known = store.sweeps.byRequest(input.requestId);
  if (known) {
    log.info("sweep.replay", { sweepId: known.id, requestId: input.requestId });
    return { status: "replay", sweep: known, submissionId: known.submissionId };
  }
  if (input.scheduled) {
    const due = deps.schedule.due(now);
    if (!due.due) {
      log.info("sweep.not_due", { requestId: input.requestId, reason: due.reason });
      return { status: "not_due", reason: due.reason };
    }
  }
  closeStalledSweeps(deps, now);
  const running = store.sweeps.active()[0];
  if (running) {
    const skipped = store.sweeps.create({
      requestId: input.requestId,
      trigger: input.trigger,
      status: "skipped",
      reason: `sweep ${running.id} is still running`,
    });
    log.info("sweep.skipped", {
      sweepId: skipped.id,
      running: running.id,
      requestId: input.requestId,
    });
    deps.bus.publish({ type: "sweep", sweep: skipped });
    return { status: "skipped", sweep: skipped };
  }
  const sweep = store.sweeps.create({
    requestId: input.requestId,
    trigger: input.trigger,
    status: "queued",
    searchMode: deps.search.mode,
  });
  if (input.scheduled) deps.schedule.recordStarted(now);
  const maxCards = input.cards ?? deps.schedule.cards();
  store.sweeps.update(sweep.id, { maxCards });
  const budget = deps.search.budget(sweep.id);
  const leads = store.sources.openLeads(5);
  store.sources.offerLeads(
    leads.map((l) => l.id),
    sweep.id,
  );
  const content = loadPrompt(
    join(config.promptsDir, "agents"),
    "news-desk",
    "USER_PROMPT_news_sweep.md",
    {
      sweep_id: sweep.id,
      max_cards: maxCards,
      now: new Date(now).toISOString(),
      since: store.sweeps.lastFinishedAt() ?? new Date(now - 24 * 3_600_000).toISOString(),
      search_mode: deps.search.mode,
      credits_left:
        deps.search.mode === "web"
          ? "not used"
          : `${budget.available} this sweep, ${budget.dailyCap - budget.dailyUsed} today`,
      topic_keywords: store.taste
        .keywords("topic", true)
        .slice(0, 8)
        .map((k) => k.term)
        .join(", "),
      timelines:
        store.news
          .timelines(8)
          .map((t) => `timeline ${t.id} "${t.title}" (${t.count} items)`)
          .join("; ") || "none",
      source_leads: leads.length
        ? leads.map((l) => `lead ${l.id} ${l.site} (upvoted: ${l.title ?? l.url})`).join("; ")
        : "none",
    },
  );
  const submission = await main.submit(
    { type: "input", content, requestId: `sweep:${sweep.id}`, whenBusy: "followUp" },
    ctx,
  );
  const updated = store.sweeps.update(sweep.id, { submissionId: submission.id as number });
  log.info("sweep.started", {
    sweepId: sweep.id,
    requestId: input.requestId,
    trigger: input.trigger,
    submissionId: submission.id,
    searchMode: deps.search.mode,
  });
  deps.bus.publish({ type: "sweep", sweep: updated });
  return { status: "accepted", sweep: updated, submissionId: submission.id as number };
}
