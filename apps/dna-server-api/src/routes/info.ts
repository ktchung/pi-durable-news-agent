// GET /healthz (open) and GET /v1/info.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Info } from "@dna/sdk";
import type { Handlers, RouteDeps } from "./types.ts";
import { packageVersion } from "../version.ts";

const versionOf = (file: string) => {
  try {
    return String(JSON.parse(readFileSync(file, "utf8")).version ?? "0.0.0");
  } catch {
    return "unknown";
  }
};

export function infoRoutes({ app }: RouteDeps): Handlers<"healthz" | "info"> {
  const version = versionOf(join(import.meta.dirname, "../../../../package.json"));
  const piDurable = packageVersion("@earendil-works/pi-durable");
  let credits: { at: number; left?: number } = { at: 0 };
  return {
    healthz: (_req, res) =>
      res.json({
        ok: true,
        version,
        device: app.config.device,
        uptime: Math.round((Date.now() - app.startedAt) / 1000),
      }),
    info: async (req, res) => {
      await app.catalog.refresh?.(req.query.refreshModels === "1").catch(() => undefined);
      await app.reconcileModel();
      if (app.search.mode === "firecrawl" && Date.now() - credits.at > 10 * 60_000)
        credits = { at: Date.now(), left: await app.search.creditsLeft() };
      const budget = app.search.budget();
      const model = await app.mainModel();
      const info: Info = {
        ok: true,
        device: app.config.device,
        deviceName: app.config.deviceName,
        mode: app.config.mode,
        version,
        piDurable,
        searchMode: app.search.mode,
        models: app.catalog.list(),
        modelCatalog: app.catalog.catalogState?.() ?? {
          source: app.catalog.provider,
          stale: false,
        },
        defaultModel: model.id,
        cronSchedule: app.config.cronSchedule,
        nextSweepAt: app.schedule.next()?.toISOString(),
        firecrawl: {
          creditsToday: budget.dailyUsed,
          dailyCap: budget.dailyCap,
          sweepCap: budget.sweepCap,
          creditsLeft: credits.left,
        },
        search: { engines: app.search.engineHealth() },
      };
      res.json(info);
    },
  };
}
