import type { ServiceConfig } from "./config";
import { sloWindowStats, windowStats, type WindowStats } from "./sli";

/**
 * SLO accounting derived from the SLIs.
 *
 * Error budget (availability):
 *   budget        = 1 - availability_target            (allowed error fraction)
 *   consumed      = observed_error_rate / budget       (0 = none used, 1 = exhausted)
 *   remaining     = 1 - consumed
 *
 * Burn rate over a window:
 *   burn_rate     = error_rate(window) / budget
 *   A burn rate of 1 means the budget is being spent exactly fast enough to
 *   exhaust it precisely at the end of the window; >1 is too fast.
 */

export type SloReport = {
  service: string;
  windowDays: number;
  // availability
  availabilityTarget: number;
  availability: number;
  availabilityMet: boolean;
  errorBudgetRatio: number; // 1 - target
  budgetConsumedRatio: number; // 0..>1 (can exceed 1 once exhausted)
  budgetRemainingRatio: number; // clamped to >= 0 for display
  // latency
  latencyPercentile: number;
  latencyTargetMs: number;
  latencyP95Ms: number | null;
  latencyMet: boolean;
  // raw window
  total: number;
  failures: number;
};

export function burnRate(errorRate: number, availabilityTarget: number): number {
  const budget = 1 - availabilityTarget;
  if (budget <= 0) return errorRate > 0 ? Infinity : 0;
  return errorRate / budget;
}

export function buildSloReport(svc: ServiceConfig, stats: WindowStats): SloReport {
  const errorBudgetRatio = 1 - svc.availability_target;
  const consumed = errorBudgetRatio > 0 ? stats.errorRate / errorBudgetRatio : 0;
  const latencyMet =
    stats.latencyPercentileMs === null ||
    stats.latencyPercentileMs <= svc.latency_target_ms;

  return {
    service: svc.name,
    windowDays: svc.window_days,
    availabilityTarget: svc.availability_target,
    availability: stats.availability,
    availabilityMet: stats.availability >= svc.availability_target,
    errorBudgetRatio,
    budgetConsumedRatio: consumed,
    budgetRemainingRatio: Math.max(0, 1 - consumed),
    latencyPercentile: svc.latency_percentile,
    latencyTargetMs: svc.latency_target_ms,
    latencyP95Ms: stats.latencyPercentileMs,
    latencyMet,
    total: stats.total,
    failures: stats.failures,
  };
}

/** Computes the full SLO report for a service over its compliance window. */
export async function evaluateSlo(svc: ServiceConfig): Promise<SloReport> {
  const stats = await sloWindowStats(svc);
  return buildSloReport(svc, stats);
}

/** Burn rate over an arbitrary trailing window (used by the alert evaluator). */
export async function burnRateOverWindow(
  svc: ServiceConfig,
  windowSeconds: number
): Promise<{ stats: WindowStats; burnRate: number }> {
  const stats = await windowStats(svc.name, windowSeconds, svc.latency_percentile);
  return { stats, burnRate: burnRate(stats.errorRate, svc.availability_target) };
}
