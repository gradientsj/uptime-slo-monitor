import { loadServices, type ServiceConfig } from "./config";
import { evaluateSlo, type SloReport } from "./slo";
import {
  evaluateAlerts,
  recentAlertEvents,
  type ServiceAlertStatus,
} from "./alerts";
import { history, recentProbes, type RecentProbe } from "./sli";
import { deriveCurrentState, type CurrentState } from "./state";
import { fillDailyCells, overallAvailability, type DayCell } from "./uptime";
import { recentIncidents, type Incident } from "./incidents";
import { readTlsStatuses, type TlsCardModel } from "./tls";

const HISTORY_DAYS = 90;

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
  uptime: {
    days: DayCell[]; // oldest first, dense (one cell per day)
    windowDays: number;
    availability: number | null;
  };
  tls: TlsCardModel | null;
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
  incidents: Incident[];
  recentAlerts: Awaited<ReturnType<typeof recentAlertEvents>>;
  // Age of the newest probe across all services; null with no data. The UI
  // shows a stale-data notice when this exceeds its threshold, instead of
  // silently presenting old probe results as the current state.
  probeDataAgeMinutes: number | null;
};

export async function getDashboard(): Promise<DashboardModel> {
  const { services } = loadServices();
  const tlsByService = await readTlsStatuses();

  const cards: ServiceCardModel[] = await Promise.all(
    services.map(async (svc) => {
      const [slo, alert, sparkline, dayBuckets] = await Promise.all([
        evaluateSlo(svc),
        evaluateAlerts(svc),
        recentProbes(svc.name, 60),
        history(svc.name, HISTORY_DAYS * 86400, HISTORY_DAYS),
      ]);
      const days = fillDailyCells(dayBuckets, HISTORY_DAYS, new Date());
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
        uptime: {
          days,
          windowDays: HISTORY_DAYS,
          availability: overallAvailability(days),
        },
        tls: tlsByService.get(svc.name) ?? null,
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

  const [incidents, recentAlerts] = await Promise.all([
    recentIncidents(HISTORY_DAYS),
    recentAlertEvents(15),
  ]);

  let newestProbeMs: number | null = null;
  for (const c of cards) {
    if (!c.lastProbe) continue;
    const t = new Date(c.lastProbe.ts).getTime();
    if (newestProbeMs === null || t > newestProbeMs) newestProbeMs = t;
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    services: cards,
    incidents,
    recentAlerts,
    probeDataAgeMinutes:
      newestProbeMs === null
        ? null
        : Math.max(0, Math.round((Date.now() - newestProbeMs) / 60_000)),
  };
}
