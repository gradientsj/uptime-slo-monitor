import type { ServiceAlertStatus } from "./alerts";

/**
 * Current-health state machine for the status page.
 *
 * Deliberately decoupled from SLO compliance: "is it working right now?" is
 * answered by recent probes and firing burn-rate alerts, while "did it meet
 * its target this month?" is the SLO report shown alongside. Coupling them
 * (the old behavior) made a service read "degraded" today because of a noise
 * burst weeks ago, long after every probe had recovered.
 */
export type CurrentState = "up" | "down" | "degraded" | "unknown";

/**
 * Derives current health from probe outcomes (newest first) and alert state.
 *
 *   - unknown:  no probe data yet
 *   - down:     a page-severity alert is firing, or the last 2+ probes failed
 *   - degraded: any alert is firing, or only the last probe failed
 *   - up:       otherwise
 *
 * With probe retries enabled, every recorded failure already survived
 * `retries + 1` consecutive fetch attempts, so two failed probes in a row is
 * a strong outage signal rather than sampling noise.
 */
export function deriveCurrentState(
  recentOk: boolean[],
  alert: Pick<ServiceAlertStatus, "firing" | "highestSeverity">
): CurrentState {
  if (recentOk.length === 0) return "unknown";

  let failureStreak = 0;
  for (const ok of recentOk) {
    if (ok) break;
    failureStreak++;
  }

  if (alert.highestSeverity === "page" || failureStreak >= 2) return "down";
  if (alert.firing || failureStreak === 1) return "degraded";
  return "up";
}
