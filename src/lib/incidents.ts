import { sql } from "./db";

/**
 * Incident detection, computed from probe history at read time.
 *
 * An incident is a run of >= `minRun` consecutive failed probes for one
 * service (a gaps-and-islands grouping). With retries enabled every recorded
 * failure already survived multiple fetch attempts, so two failed probes in
 * a row is a sustained outage, while single-probe blips stay out of the
 * timeline. Computing on read means past data is covered without a backfill.
 */

export type Incident = {
  service: string;
  startedAt: string; // ISO
  lastFailureAt: string; // ISO
  failedProbes: number;
  sampleError: string | null;
  ongoing: boolean;
  // First to last observed failure; the real outage extends up to one probe
  // interval beyond each end, so the UI presents this as a minimum.
  durationMinutes: number;
};

export type IncidentRow = {
  service: string;
  started_at: Date;
  last_failure_at: Date;
  failed_probes: number;
  sample_error: string | null;
};

export type LatestProbe = {
  service: string;
  ts: Date;
  ok: boolean;
};

/** Pure assembly so ongoing/duration logic is testable without a database. */
export function assembleIncidents(
  rows: IncidentRow[],
  latest: LatestProbe[]
): Incident[] {
  const latestByService = new Map(latest.map((l) => [l.service, l]));
  return rows.map((r) => {
    const last = latestByService.get(r.service);
    const ongoing =
      !!last && !last.ok && last.ts.getTime() === r.last_failure_at.getTime();
    return {
      service: r.service,
      startedAt: r.started_at.toISOString(),
      lastFailureAt: r.last_failure_at.toISOString(),
      failedProbes: r.failed_probes,
      sampleError: r.sample_error,
      ongoing,
      durationMinutes: Math.max(
        0,
        Math.round(
          (r.last_failure_at.getTime() - r.started_at.getTime()) / 60_000
        )
      ),
    };
  });
}

/** Incidents across all services over the trailing window, newest first. */
export async function recentIncidents(
  windowDays = 90,
  minRun = 2,
  limit = 20
): Promise<Incident[]> {
  const rows = await sql<IncidentRow[]>`
    WITH recent AS (
      SELECT service, ts, ok, error
      FROM probe_results
      WHERE ts >= now() - make_interval(days => ${windowDays})
    ),
    numbered AS (
      SELECT *,
        row_number() OVER (PARTITION BY service ORDER BY ts)
          - row_number() OVER (PARTITION BY service, ok ORDER BY ts) AS island
      FROM recent
    )
    SELECT
      service,
      min(ts) AS started_at,
      max(ts) AS last_failure_at,
      count(*)::int AS failed_probes,
      (array_agg(error ORDER BY ts DESC))[1] AS sample_error
    FROM numbered
    WHERE NOT ok
    GROUP BY service, island
    HAVING count(*) >= ${minRun}
    ORDER BY min(ts) DESC
    LIMIT ${limit}
  `;

  const latest = await sql<LatestProbe[]>`
    SELECT DISTINCT ON (service) service, ts, ok
    FROM probe_results
    ORDER BY service, ts DESC
  `;

  return assembleIncidents(rows, latest);
}
