// Persisted cron/timezone/card settings. Heartbeats are accepted only by the cron workflow, never here.
import { invalid } from "../errors.ts";
import type { ScheduleSetting } from "../news/schedule.ts";
import { bodyOf, type Handlers, type RouteDeps } from "./types.ts";

export function scheduleRoutes({ app }: RouteDeps): Handlers<"schedule.get" | "schedule.set"> {
  return {
    "schedule.get": (_req, res) => res.json(app.schedule.state()),
    "schedule.set": (req, res) => {
      const body = bodyOf(req);
      const allowed = ["cronExpression", "timezone", "everyMinutes", "cardsPerSweep"];
      if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key)))
        throw invalid("Send only cronExpression, timezone, cardsPerSweep, or legacy everyMinutes");
      const state = app.schedule.set(body as ScheduleSetting);
      app.log.info("schedule.set", {
        cronExpression: state.cronExpression,
        timezone: state.timezone,
        cardsPerSweep: state.cardsPerSweep,
      });
      app.bus.publish({ type: "schedule", schedule: state });
      res.json(state);
    },
  };
}
