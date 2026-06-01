import { loadServices, type ServiceConfig } from "./config";
import { sql } from "./db";
import { evaluateSlo, type SloReport } from "./slo";
import {
  evaluateAlerts,
  recentAlertEvents,
  type ServiceAlertStatus,
} from "./alerts";
import { recentProbes, type RecentProbe } from "./sli";

/**
 * Read models for the status page. Aggregates the probe/SLI/SLO/alert layers
 * into the shapes the UI renders.
 */

export type ServiceCardModel = {
  config: Pick<ServiceConfig, "name" | "description" | "url">;
  lastProbe: { ts: string; ok: boolean; latency_ms: number | null } | null;
  state: "up" | "down" | "degraded" | "unknown";
  slo: SloReport;
  alert: ServiceAlertStatus;
  sparkline: RecentProbe[]; // newest first
};

export type DashboardModel = {
  generatedAt: string;
  summary: {
    total: number;
    up: number;
    down: number;
    degraded: number;
    firingServices: number;
  };
  services: ServiceCardModel[];
  recentAlerts: Awaited<ReturnType<typeof recentAlertEvents>>;
};

function deriveState(
  lastOk: boolean | null,
  slo: SloReport,
  alert: ServiceAlertStatus
): ServiceCardModel["state"] {
  if (lastOk === null) return "unknown";
  if (!lastOk || alert.highestSeverity === "page") return "down";
  if (!slo.latencyMet || !slo.availabilityMet || alert.firing) return "degraded";
  return "up";
}

export async function getDashboard(): Promise<DashboardModel> {
  const { services } = loadServices();

  const lastRows = await sql<
    { service: string; ts: Date; ok: boolean; latency_ms: number | null }[]
  >`
    SELECT DISTINCT ON (service) service, ts, ok, latency_ms
    FROM probe_results
    ORDER BY service, ts DESC
  `;
  const lastByService = new Map(lastRows.map((r) => [r.service, r]));

  const cards: ServiceCardModel[] = await Promise.all(
    services.map(async (svc) => {
      const [slo, alert, sparkline] = await Promise.all([
        evaluateSlo(svc),
        evaluateAlerts(svc),
        recentProbes(svc.name, 60),
      ]);
      const last = lastByService.get(svc.name) ?? null;
      const state = deriveState(last ? last.ok : null, slo, alert);
      return {
        config: { name: svc.name, description: svc.description, url: svc.url },
        lastProbe: last
          ? { ts: last.ts.toISOString(), ok: last.ok, latency_ms: last.latency_ms }
          : null,
        state,
        slo,
        alert,
        sparkline,
      };
    })
  );

  const summary = {
    total: cards.length,
    up: cards.filter((c) => c.state === "up").length,
    down: cards.filter((c) => c.state === "down").length,
    degraded: cards.filter((c) => c.state === "degraded").length,
    firingServices: cards.filter((c) => c.alert.firing).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    services: cards,
    recentAlerts: await recentAlertEvents(15),
  };
}
