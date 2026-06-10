import { loadServices, type ServiceConfig } from "./config";
import { evaluateSlo, type SloReport } from "./slo";
import {
  evaluateAlerts,
  recentAlertEvents,
  type ServiceAlertStatus,
} from "./alerts";
import { recentProbes, type RecentProbe } from "./sli";
import { deriveCurrentState, type CurrentState } from "./state";

/**
 * Read models for the status page. Aggregates the probe/SLI/SLO/alert layers
 * into the shapes the UI renders.
 */

export type ServiceCardModel = {
  config: Pick<ServiceConfig, "name" | "description" | "url">;
  lastProbe: { ts: string; ok: boolean; latency_ms: number | null } | null;
  // Current health (recent probes + firing alerts). SLO compliance over the
  // rolling window is reported separately in `slo`.
  state: CurrentState;
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
    sloBreached: number;
  };
  services: ServiceCardModel[];
  recentAlerts: Awaited<ReturnType<typeof recentAlertEvents>>;
};

export async function getDashboard(): Promise<DashboardModel> {
  const { services } = loadServices();

  const cards: ServiceCardModel[] = await Promise.all(
    services.map(async (svc) => {
      const [slo, alert, sparkline] = await Promise.all([
        evaluateSlo(svc),
        evaluateAlerts(svc),
        recentProbes(svc.name, 60),
      ]);
      const last = sparkline[0] ?? null;
      const state = deriveCurrentState(
        sparkline.map((p) => p.ok),
        alert
      );
      return {
        config: { name: svc.name, description: svc.description, url: svc.url },
        lastProbe: last
          ? {
              ts: new Date(last.ts).toISOString(),
              ok: last.ok,
              latency_ms: last.latency_ms,
            }
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
    sloBreached: cards.filter(
      (c) => !c.slo.availabilityMet || !c.slo.latencyMet
    ).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    services: cards,
    recentAlerts: await recentAlertEvents(15),
  };
}
