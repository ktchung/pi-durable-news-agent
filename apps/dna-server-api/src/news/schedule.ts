// DNA_CRON_SCHEDULE is only the transport tick. This persisted five-field cron is the sweep schedule.
import { CronDate, CronExpressionParser } from "cron-parser";
import type { ScheduleState } from "@dna/sdk";
import type { Store } from "../db/store.ts";
import { invalid } from "../errors.ts";

export const SCHEDULE_PRESETS = [1, 5, 10, 15, 30, 60] as const;
export const DEFAULT_SWEEP_CRON = "0 */8 * * *";
export const DEFAULT_CARDS = 7;
export const MAX_CARDS = 30;
export const TICK_STALE_MS = 90_000;
const MINUTE = 60_000;

export interface ScheduleSetting {
  cronExpression?: string | null;
  timezone?: string;
  /** Legacy API only; canonical persistence always uses cronExpression. */
  everyMinutes?: number | null;
  cardsPerSweep?: number;
}
interface CanonicalSetting {
  cronExpression: string | null;
  timezone: string;
  cardsPerSweep: number;
}

/** The transport's tick in minutes (legacy display/presets, not a sweep interval). */
export function tickMinutes(cronSchedule: string): number {
  const minute = cronSchedule.trim().split(/\s+/)[0];
  if (minute === "*") return 1;
  const step = minute.match(/^\*\/(\d+)$/)?.[1];
  return step ? Number(step) : 60;
}

function validate(setting: CanonicalSetting): CanonicalSetting {
  const { cronExpression, timezone, cardsPerSweep } = setting;
  if (typeof timezone !== "string" || !timezone || /^[+-]/.test(timezone))
    throw invalid("timezone must be a valid IANA timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw invalid("timezone must be a valid IANA timezone");
  }
  if (!Number.isInteger(cardsPerSweep) || cardsPerSweep < 1 || cardsPerSweep > MAX_CARDS)
    throw invalid(`cardsPerSweep must be an integer from 1 to ${MAX_CARDS}`);
  if (cronExpression !== null) {
    if (typeof cronExpression !== "string" || cronExpression.trim().split(/\s+/).length !== 5)
      throw invalid("cronExpression must contain exactly five cron fields, or null for off");
    // Hashed/random fields would change on each parse, so cannot be a durable schedule.
    if (/H/i.test(cronExpression.replace(/THU/gi, "")))
      throw invalid("cronExpression does not support random hashed fields");
  }
  try {
    // Validate parser timezone support even when the persisted schedule is off.
    CronExpressionParser.parse(cronExpression ?? DEFAULT_SWEEP_CRON, { tz: timezone }).next();
  } catch (error) {
    throw invalid(`Invalid cronExpression or timezone: ${(error as Error).message}`);
  }
  return setting;
}

export class Schedule {
  private lastTick?: number;

  constructor(
    private readonly deps: {
      store: Store;
      cronSchedule: string;
      sweepCron?: string;
      sweepTimezone?: string;
    },
  ) {
    const saved = deps.store.settings.get<ScheduleSetting>("schedule", {});
    // Migrate only once. Explicit off survives; legacy enabled intervals (including the old 5m default)
    // adopt the safe seed instead. A canonical UI setting always wins over environment changes.
    const setting = validate({
      cronExpression:
        saved.cronExpression !== undefined
          ? saved.cronExpression
          : saved.everyMinutes === null
            ? null
            : (deps.sweepCron ?? DEFAULT_SWEEP_CRON),
      timezone: saved.timezone ?? deps.sweepTimezone ?? "UTC",
      cardsPerSweep: saved.cardsPerSweep ?? DEFAULT_CARDS,
    });
    if (
      saved.cronExpression === undefined ||
      saved.timezone === undefined ||
      saved.cardsPerSweep === undefined
    )
      deps.store.settings.set("schedule", setting);
  }

  get tick(): number {
    return tickMinutes(this.deps.cronSchedule);
  }

  presets(): number[] {
    return SCHEDULE_PRESETS.filter((m) => m >= this.tick && m % this.tick === 0);
  }

  private setting(): CanonicalSetting {
    return this.deps.store.settings.get<CanonicalSetting>("schedule", {
      cronExpression: DEFAULT_SWEEP_CRON,
      timezone: "UTC",
      cardsPerSweep: DEFAULT_CARDS,
    });
  }

  /** Legacy projection only: null can also mean a custom cron. Use cronExpression for enabled/off. */
  every(): number | null {
    const cron = this.setting().cronExpression?.trim().replace(/\s+/g, " ");
    if (cron === "* * * * *" || cron === "*/1 * * * *") return 1;
    if (cron === "0 * * * *") return 60;
    const minute = cron?.match(/^\*\/(\d+) \* \* \* \*$/)?.[1];
    if (minute && 60 % Number(minute) === 0) return Number(minute);
    const hour = cron?.match(/^0 \*\/(\d+) \* \* \*$/)?.[1];
    if (hour && 24 % Number(hour) === 0) return Number(hour) * 60;
    return null;
  }

  cards(): number {
    return this.setting().cardsPerSweep;
  }

  set(patch: ScheduleSetting): ScheduleState {
    if (patch.cronExpression !== undefined && patch.everyMinutes !== undefined)
      throw invalid("Send cronExpression or legacy everyMinutes, not both");
    let cron = patch.cronExpression;
    if (patch.everyMinutes !== undefined) {
      const every = patch.everyMinutes;
      if (every !== null && !this.presets().includes(every))
        throw invalid(`everyMinutes must be one of ${this.presets().join(", ")}, or null for off`);
      cron =
        every === null
          ? null
          : every === 1
            ? "* * * * *"
            : every === 60
              ? "0 * * * *"
              : `*/${every} * * * *`;
    }
    // Validate the entire candidate before the single write, including combined cards/cron edits.
    const next = validate({
      ...this.setting(),
      ...(cron !== undefined ? { cronExpression: cron } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.cardsPerSweep !== undefined ? { cardsPerSweep: patch.cardsPerSweep } : {}),
    });
    this.deps.store.settings.set("schedule", next);
    return this.state();
  }

  /** Only called by the cron-authorized workflow, never a client settings write. Not persisted. */
  recordTick(now = Date.now()): void {
    this.lastTick = now;
  }

  /** Durable absolute-minute dedupe; call synchronously with creation, before the first await. */
  recordStarted(now = Date.now()): void {
    this.deps.store.settings.set("schedule.lastStartedMinute", Math.floor(now / MINUTE));
  }

  due(now = Date.now()): { due: true } | { due: false; reason: string } {
    const { cronExpression, timezone } = this.setting();
    if (cronExpression === null) return { due: false, reason: "Scheduled sweeps are off" };
    const minute = Math.floor(now / MINUTE);
    const cron = CronExpressionParser.parse(cronExpression, { tz: timezone });
    // Floor seconds, not the schedule: missed minutes never catch up. includesDate preserves parser's
    // DOM/DOW OR semantics and does not shift nonexistent DST wall times into a different hour.
    if (!cron.includesDate(new Date(minute * MINUTE)))
      return { due: false, reason: "Not a matching scheduled minute" };
    const last = this.deps.store.sweeps.lastCronAt();
    if (
      this.deps.store.settings.get<number | null>("schedule.lastStartedMinute", null) === minute ||
      (last && Math.floor(Date.parse(last) / MINUTE) === minute)
    )
      return { due: false, reason: "Already swept this scheduled minute" };
    return { due: true };
  }

  /** Configured upcoming slot, not evidence that the transport ticker is alive. */
  nextScheduled(now = Date.now()): Date | undefined {
    const { cronExpression, timezone } = this.setting();
    if (cronExpression === null) return undefined;
    const cron = CronExpressionParser.parse(cronExpression, { tz: timezone, currentDate: now });
    // cron-parser shifts a nonexistent spring-forward hour; such a minute is deliberately not due.
    for (let i = 0; i < 4; i++) {
      const next = cron.next().toDate();
      if (!cron.includesDate(next)) continue;
      // The iterator suppresses a repeated fall-back wall hour when starting before the rollback.
      // Our slots are absolute minutes, so include that second occurrence. Only scan on rollback days.
      const horizon = now + 26 * 60 * MINUTE;
      if (
        new CronDate(now, timezone).getUTCOffset() > new CronDate(horizon, timezone).getUTCOffset()
      ) {
        for (
          let time = (Math.floor(now / MINUTE) + 1) * MINUTE;
          time < Math.min(next.getTime(), horizon);
          time += MINUTE
        ) {
          if (cron.includesDate(new Date(time))) return new Date(time);
        }
      }
      return next;
    }
    return undefined;
  }

  /** Compatibility callers (agent state) must not advertise a sweep without a live ticker. */
  next(now = Date.now()): Date | undefined {
    if (this.lastTick === undefined || now - this.lastTick > TICK_STALE_MS) return undefined;
    return this.nextScheduled(now);
  }

  state(now = Date.now()): ScheduleState {
    const setting = this.setting();
    const schedulerStatus =
      this.lastTick === undefined
        ? "waiting"
        : now - this.lastTick <= TICK_STALE_MS
          ? "running"
          : "stale";
    const nextScheduledAt = this.nextScheduled(now)?.toISOString();
    return {
      ...setting,
      everyMinutes: this.every(),
      presets: this.presets(),
      tickMinutes: this.tick,
      schedulerStatus,
      lastTickAt: this.lastTick === undefined ? undefined : new Date(this.lastTick).toISOString(),
      nextScheduledAt,
      nextSweepAt: schedulerStatus === "running" ? nextScheduledAt : undefined,
    };
  }
}
