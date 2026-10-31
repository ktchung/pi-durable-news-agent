<script setup lang="ts">
import { computed, ref } from "vue";
import { Clock } from "@lucide/vue";
import { agentState, api, connection, feed, now } from "../client/store";

const DEFAULT_CRON = "0 */8 * * *";
// A stopped ticker cannot send a final stale event. Age the heartbeat locally too.
const TICK_STALE_MS = 90_000;
const schedule = computed(() => agentState.value?.schedule);
const off = computed(
  () =>
    schedule.value?.cronExpression === null ||
    (schedule.value?.cronExpression === undefined && schedule.value?.everyMinutes === null),
);
const tickerStale = computed(() => {
  const tick = Date.parse(schedule.value?.lastTickAt ?? "");
  return (
    schedule.value?.schedulerStatus === "stale" ||
    (Number.isFinite(tick) && now.value - tick > TICK_STALE_MS)
  );
});
const tickerRunning = computed(
  () =>
    connection.value === "live" &&
    schedule.value?.schedulerStatus === "running" &&
    Number.isFinite(Date.parse(schedule.value.lastTickAt ?? "")) &&
    !tickerStale.value,
);
const status = computed(() => {
  if (off.value) return "Scheduled sweeps off";
  if (connection.value !== "live") return "Ticker status unavailable";
  if (tickerStale.value) return "Ticker stale · not running";
  if (schedule.value?.schedulerStatus === "waiting") return "Waiting for ticker";
  if (!tickerRunning.value) return "Ticker status unavailable";
  // Only canonical running state supplies a countdown, never old info/agent timestamps.
  const at = Date.parse(schedule.value?.nextSweepAt ?? "");
  if (!Number.isFinite(at) || at <= now.value) return "Awaiting ticker update";
  const seconds = Math.ceil((at - now.value) / 1000);
  const minutes = Math.floor(seconds / 60);
  const duration =
    seconds >= 3600
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `Next sweep in ${duration}`;
});
const savedCron = computed(() =>
  off.value
    ? "Off"
    : (schedule.value?.cronExpression ??
      (schedule.value ? `Every ${schedule.value.everyMinutes} min (legacy)` : "Unavailable")),
);
function localTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not reported";
  if (!schedule.value?.timezone) return `${value} (timezone not reported)`;
  try {
    return new Intl.DateTimeFormat("en", {
      timeZone: schedule.value.timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}
const dialog = ref<HTMLDialogElement>();
const expression = ref(DEFAULT_CRON);
const timezone = ref("");
const pending = ref(false);
const error = ref("");
function resetDraft() {
  expression.value = schedule.value?.cronExpression ?? DEFAULT_CRON;
  timezone.value = schedule.value?.timezone ?? "";
}
function open() {
  resetDraft();
  error.value = "";
  dialog.value?.showModal();
}
const unchanged = computed(
  () =>
    expression.value === schedule.value?.cronExpression &&
    timezone.value === (schedule.value?.timezone ?? ""),
);
async function save(cronExpression: string | null) {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    // Off is independent of an unfinished (possibly invalid) timezone draft.
    const zone = cronExpression === null ? schedule.value?.timezone : timezone.value || undefined;
    const next = await api.setCronSchedule(cronExpression, zone);
    feed.apply({ type: "schedule", schedule: next });
    resetDraft();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <span class="scheduler-status" data-testid="scheduler-status"
    ><Clock :size="16" />{{ status }}</span
  >
  <button
    v-if="schedule"
    class="schedule-select schedule-trigger"
    data-cap="schedule"
    aria-label="Edit sweep schedule"
    aria-haspopup="dialog"
    :title="`${savedCron} · ${schedule.timezone ?? 'Timezone not reported'}`"
    @click="open"
  >
    Schedule
  </button>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="schedule-dialog"
      aria-labelledby="sweep-schedule-title"
      @cancel="pending && $event.preventDefault()"
    >
      <form @submit.prevent="save(expression)">
        <div class="schedule-heading">
          <h2 id="sweep-schedule-title">Sweep schedule</h2>
          <button
            type="button"
            class="button secondary small"
            :disabled="pending"
            @click="dialog?.close()"
          >
            Close
          </button>
        </div>
        <dl class="schedule-summary">
          <dt>Configured</dt>
          <dd class="mono" data-testid="saved-cron">{{ savedCron }}</dd>
          <dt>Timezone</dt>
          <dd>{{ schedule?.timezone ?? "Not reported by server" }}</dd>
          <dt>Next configured time</dt>
          <dd data-testid="configured-next">
            {{ off ? "Off" : localTime(schedule?.nextScheduledAt) }}
          </dd>
        </dl>
        <p class="schedule-runtime" role="status">
          {{ status
          }}<template v-if="!off && !tickerRunning"
            >. Configured time only; no running ticker confirmed.</template
          >
        </p>
        <label for="sweep-cron">Cron expression</label>
        <input
          id="sweep-cron"
          v-model="expression"
          class="mono"
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="error ? 'sweep-cron-hint sweep-schedule-error' : 'sweep-cron-hint'"
          :aria-invalid="error ? true : undefined"
          :disabled="pending"
        />
        <p id="sweep-cron-hint" class="muted">
          Five fields: minute, hour, day, month, weekday.<br />Default:
          <code>0 */8 * * *</code> (every eight hours).
        </p>
        <label for="sweep-timezone">Timezone</label>
        <input
          id="sweep-timezone"
          v-model="timezone"
          autocomplete="off"
          spellcheck="false"
          placeholder="Server default (not reported)"
          :aria-describedby="
            error ? 'sweep-timezone-hint sweep-schedule-error' : 'sweep-timezone-hint'
          "
          :aria-invalid="error ? true : undefined"
          :disabled="pending"
        />
        <p id="sweep-timezone-hint" class="muted">
          Server timezone, for example Asia/Shanghai or UTC. Saving does not run a sweep.
        </p>
        <p v-if="error" id="sweep-schedule-error" class="bad schedule-error" role="alert">
          {{ error }}
        </p>
        <div class="schedule-actions">
          <button
            type="button"
            class="button secondary small"
            :disabled="pending || off"
            @click="save(null)"
          >
            Off
          </button>
          <button
            type="submit"
            class="button small"
            :disabled="pending || !expression.trim() || unchanged"
          >
            {{ pending ? "Saving…" : "Save" }}
          </button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.scheduler-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.scheduler-status svg {
  flex-shrink: 0;
}
.schedule-trigger {
  white-space: nowrap;
}
.schedule-dialog {
  width: min(440px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 24px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
}
.schedule-dialog::backdrop {
  background: #0008;
}
.schedule-heading,
.schedule-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.schedule-heading h2 {
  font-size: 16px;
}
.schedule-summary {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.schedule-summary dt {
  color: var(--muted);
  margin-top: 8px;
}
.schedule-summary dd {
  margin: 0;
}
.schedule-runtime {
  padding-block: 8px;
  border-block: 1px solid var(--line);
  font-size: 13px;
}
.schedule-dialog label {
  display: block;
  margin-top: 16px;
  margin-bottom: 4px;
  font-size: 13px;
}
.schedule-dialog input {
  width: 100%;
  min-width: 0;
}
.schedule-dialog p {
  font-size: 12px;
}
.schedule-error {
  overflow-wrap: anywhere;
}
.schedule-actions {
  margin-top: 20px;
}
</style>
