import { sql } from "./db";
import type { ServiceConfig } from "./config";

/**
 * Service Level Indicators computed from raw probe_results over rolling
 * windows. Two SLIs are tracked per service:
 *   - availability: fraction of probes that succeeded
 *   - latency:      the configured percentile of successful-probe latency
 */

export type WindowStats = {
  total: number;
  failures: number;
  availability: number; // successes / total, 1 when no data
  errorRate: number; // failures / total, 0 when no data
  latencyPercentileMs: number | null;
  avgLatencyMs: number | null;
};

/**
 * Aggregates probe results for one service over the trailing `windowSeconds`.
 * `percentile` is 0..100 (e.g. 95). Latency percentiles consider only probes
 * that returned a latency sample.
 */
export async function windowStats(
  service: string,
  windowSeconds: number,
  percentile: number
): Promise<WindowStats> {
  const frac = percentile / 100;
  const [row] = await sql<
    {
      total: number;
      failures: number;
      p: number | null;
      avg: number | null;
    }[]
  >`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE NOT ok)::int AS failures,
      percentile_cont(${frac}) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p,
      avg(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS avg
    FROM probe_results
    WHERE service = ${service}
      AND ts >= now() - make_interval(secs => ${windowSeconds})
  `;

  const total = row?.total ?? 0;
  const failures = row?.failures ?? 0;
  return {
    total,
    failures,
    availability: total === 0 ? 1 : (total - failures) / total,
    errorRate: total === 0 ? 0 : failures / total,
    latencyPercentileMs: row?.p ?? null,
    avgLatencyMs: row?.avg ?? null,
  };
}

/** Convenience: SLIs over the service's full SLO compliance window. */
export async function sloWindowStats(svc: ServiceConfig): Promise<WindowStats> {
  return windowStats(svc.name, svc.window_days * 86400, svc.latency_percentile);
}

export type RecentProbe = {
  ts: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
};

/** The most recent N probes for a service, newest first (for sparklines/log). */
export async function recentProbes(
  service: string,
  limit = 60
): Promise<RecentProbe[]> {
  const rows = await sql<RecentProbe[]>`
    SELECT ts, ok, status_code, latency_ms, error
    FROM probe_results
    WHERE service = ${service}
    ORDER BY ts DESC
    LIMIT ${limit}
  `;
  return rows;
}

export type Bucket = {
  bucket: string; // ISO timestamp of bucket start
  total: number;
  failures: number;
  availability: number;
  p95_ms: number | null;
};

/**
 * Time-bucketed history for charts: availability + p95 latency per bucket over
 * `windowSeconds`, using `buckets` evenly-spaced intervals.
 */
export async function history(
  service: string,
  windowSeconds: number,
  buckets = 48
): Promise<Bucket[]> {
  const widthSeconds = Math.max(60, Math.floor(windowSeconds / buckets));
  const rows = await sql<
    {
      bucket: Date;
      total: number;
      failures: number;
      p95: number | null;
    }[]
  >`
    SELECT
      to_timestamp(floor(extract(epoch FROM ts) / ${widthSeconds}) * ${widthSeconds}) AS bucket,
      count(*)::int AS total,
      count(*) FILTER (WHERE NOT ok)::int AS failures,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p95
    FROM probe_results
    WHERE service = ${service}
      AND ts >= now() - make_interval(secs => ${windowSeconds})
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    total: r.total,
    failures: r.failures,
    availability: r.total === 0 ? 1 : (r.total - r.failures) / r.total,
    p95_ms: r.p95,
  }));
}
