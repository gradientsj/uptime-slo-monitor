import type { ServiceConfig } from "./config";
import { sql } from "./db";
import { burnRate } from "./slo";
import { windowStats, type WindowStats } from "./sli";

/**
 * Multi-window, multi-burn-rate alerting (Google SRE Workbook, ch. "Alerting
 * on SLOs"). Each policy pairs a long and a short window and a burn-rate
 * threshold. The policy fires only when BOTH windows exceed the threshold:
 *   - the long window establishes that budget is genuinely burning,
 *   - the short window makes the alert fire fast and reset fast once recovered.
 *
 * Thresholds/windows are tuned for a 30-day SLO window. A fast burn pages
 * immediately; a slow burn raises a ticket/warning.
 */

export type AlertPolicy = {
  name: string;
  severity: "page" | "ticket";
  burnRateThreshold: number;
  longWindowSeconds: number;
  shortWindowSeconds: number;
  label: string;
  // Minimum probe samples required in the long window before the policy may
  // fire, to avoid alerting on a tiny number of data points.
  minLongSamples: number;
};

export const POLICIES: AlertPolicy[] = [
  {
    name: "fast-burn",
    severity: "page",
    burnRateThreshold: 14.4, // ~2% of a 30d budget in 1h
    longWindowSeconds: 60 * 60, // 1h
    shortWindowSeconds: 5 * 60, // 5m
    label: "1h/5m @ 14.4x",
    minLongSamples: 5,
  },
  {
    name: "fast-burn-6h",
    severity: "page",
    burnRateThreshold: 6, // ~5% of budget in 6h
    longWindowSeconds: 6 * 60 * 60, // 6h
    shortWindowSeconds: 30 * 60, // 30m
    label: "6h/30m @ 6x",
    minLongSamples: 10,
  },
  {
    name: "slow-burn-1d",
    severity: "ticket",
    burnRateThreshold: 3, // ~10% of budget in 1d
    longWindowSeconds: 24 * 60 * 60, // 1d
    shortWindowSeconds: 2 * 60 * 60, // 2h
    label: "1d/2h @ 3x",
    minLongSamples: 20,
  },
  {
    name: "slow-burn-3d",
    severity: "ticket",
    burnRateThreshold: 1,
    longWindowSeconds: 3 * 24 * 60 * 60, // 3d
    shortWindowSeconds: 6 * 60 * 60, // 6h
    label: "3d/6h @ 1x",
    minLongSamples: 30,
  },
];

export type PolicyEvaluation = {
  policy: string;
  severity: "page" | "ticket";
  label: string;
  threshold: number;
  longBurnRate: number;
  shortBurnRate: number;
  longStats: WindowStats;
  shortStats: WindowStats;
  firing: boolean;
};

export type ServiceAlertStatus = {
  service: string;
  firing: boolean;
  highestSeverity: "page" | "ticket" | null;
  evaluations: PolicyEvaluation[];
};

/** Evaluates every policy for one service against current probe data. */
export async function evaluateAlerts(
  svc: ServiceConfig
): Promise<ServiceAlertStatus> {
  const evaluations: PolicyEvaluation[] = [];

  for (const p of POLICIES) {
    const [longStats, shortStats] = await Promise.all([
      windowStats(svc.name, p.longWindowSeconds, svc.latency_percentile),
      windowStats(svc.name, p.shortWindowSeconds, svc.latency_percentile),
    ]);
    evaluations.push(evaluatePolicy(svc, p, longStats, shortStats));
  }

  return summarizeAlertStatus(svc.name, evaluations);
}

export function evaluatePolicy(
  svc: ServiceConfig,
  policy: AlertPolicy,
  longStats: WindowStats,
  shortStats: WindowStats
): PolicyEvaluation {
  const longBurnRate = burnRate(longStats.errorRate, svc.availability_target);
  const shortBurnRate = burnRate(shortStats.errorRate, svc.availability_target);
  const firing =
    longStats.total >= policy.minLongSamples &&
    shortStats.total >= 1 &&
    longBurnRate >= policy.burnRateThreshold &&
    shortBurnRate >= policy.burnRateThreshold;

  return {
    policy: policy.name,
    severity: policy.severity,
    label: policy.label,
    threshold: policy.burnRateThreshold,
    longBurnRate,
    shortBurnRate,
    longStats,
    shortStats,
    firing,
  };
}

export function summarizeAlertStatus(
  service: string,
  evaluations: PolicyEvaluation[]
): ServiceAlertStatus {
  const firingEvals = evaluations.filter((e) => e.firing);
  const highestSeverity = firingEvals.some((e) => e.severity === "page")
    ? "page"
    : firingEvals.length > 0
      ? "ticket"
      : null;

  return {
    service,
    firing: firingEvals.length > 0,
    highestSeverity,
    evaluations,
  };
}

/**
 * Reconciles evaluated alert state with what's stored, writing an alert_event
 * row on every firing<->ok transition. Returns the transitions that occurred.
 * "Recorded + shown in UI" alerting: no external push, just durable history.
 */
export async function persistAlertTransitions(
  status: ServiceAlertStatus
): Promise<{ policy: string; from: string; to: string }[]> {
  const transitions: { policy: string; from: string; to: string }[] = [];

  for (const ev of status.evaluations) {
    const desired = ev.firing ? "firing" : "ok";
    const [existing] = await sql<{ state: string }[]>`
      SELECT state FROM alert_state
      WHERE service = ${status.service} AND policy = ${ev.policy}
    `;
    const prev = existing?.state ?? "ok";

    if (prev !== desired) {
      transitions.push({ policy: ev.policy, from: prev, to: desired });
      const message =
        desired === "firing"
          ? `${ev.severity.toUpperCase()} ${ev.policy}: burn ${ev.longBurnRate.toFixed(
              1
            )}x (long) / ${ev.shortBurnRate.toFixed(1)}x (short) >= ${ev.threshold}x`
          : `resolved ${ev.policy}`;
      await sql`
        INSERT INTO alert_events
          (service, policy, severity, state, burn_rate, long_window, short_window, message)
        VALUES (
          ${status.service}, ${ev.policy}, ${ev.severity},
          ${desired === "firing" ? "firing" : "resolved"},
          ${ev.longBurnRate === Infinity ? null : ev.longBurnRate},
          ${humanWindow(ev, "long")}, ${humanWindow(ev, "short")}, ${message}
        )
      `;
    }

    await sql`
      INSERT INTO alert_state (service, policy, state, since, updated_at)
      VALUES (${status.service}, ${ev.policy}, ${desired}, now(), now())
      ON CONFLICT (service, policy) DO UPDATE
        SET state = EXCLUDED.state,
            updated_at = now(),
            since = CASE WHEN alert_state.state <> EXCLUDED.state
                         THEN now() ELSE alert_state.since END
    `;
  }

  return transitions;
}

function humanWindow(ev: PolicyEvaluation, which: "long" | "short"): string {
  return ev.label.split(" ")[0].split("/")[which === "long" ? 0 : 1] ?? "";
}

/** Recent alert events across all services for the UI activity feed. */
export async function recentAlertEvents(limit = 25) {
  return sql<
    {
      service: string;
      policy: string;
      severity: string;
      state: string;
      burn_rate: number | null;
      message: string;
      ts: string;
    }[]
  >`
    SELECT service, policy, severity, state, burn_rate, message, ts
    FROM alert_events
    ORDER BY ts DESC
    LIMIT ${limit}
  `;
}
