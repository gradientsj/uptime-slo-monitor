import type { Bucket } from "./sli";

/**
 * Daily uptime cells for the per-service history strip (the classic
 * status-page row of green/yellow/red day bars). Pure transforms over the
 * bucketed history query so they are testable without a database.
 */

export type DayCell = {
  date: string; // YYYY-MM-DD (UTC)
  total: number;
  failures: number;
  availability: number | null; // null = no probes recorded that day
  p95_ms: number | null;
};

/**
 * Expands day-bucketed history into a dense `days`-long array ending today
 * (UTC), filling days with no data (beyond retention, or before monitoring
 * started) with empty cells so the strip always renders a full window.
 */
export function fillDailyCells(
  buckets: Bucket[],
  days: number,
  now: Date
): DayCell[] {
  const byDay = new Map<string, Bucket>();
  for (const b of buckets) byDay.set(b.bucket.slice(0, 10), b);

  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const cells: DayCell[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10);
    const b = byDay.get(date);
    cells.push(
      b
        ? {
            date,
            total: b.total,
            failures: b.failures,
            availability: b.availability,
            p95_ms: b.p95_ms,
          }
        : { date, total: 0, failures: 0, availability: null, p95_ms: null }
    );
  }
  return cells;
}

/** Probe-weighted availability across the whole strip; null with no data. */
export function overallAvailability(cells: DayCell[]): number | null {
  let total = 0;
  let failures = 0;
  for (const c of cells) {
    total += c.total;
    failures += c.failures;
  }
  return total === 0 ? null : (total - failures) / total;
}
