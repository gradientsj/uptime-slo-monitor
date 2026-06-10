import type { ServiceConfig } from "./config";
import { sql } from "./db";

export type ProbeResult = {
  service: string;
  ts: Date;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  attempts: number;
};

/**
 * Probes a single service once. Measures wall-clock latency, enforces a
 * per-service timeout, and treats only the configured status codes as success.
 * Never throws — failures are captured in the returned result.
 */
export async function probeOnce(svc: ServiceConfig): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), svc.timeout_ms);
  const startedAt = new Date();
  const t0 = performance.now();

  try {
    const res = await fetch(svc.url, {
      method: svc.method,
      signal: ctrl.signal,
      redirect: "manual",
      // Identify ourselves and avoid caches skewing latency.
      headers: {
        "user-agent": "uptime-slo-monitor/1.0 (+https://stanleyjacob.dev)",
        "cache-control": "no-cache",
      },
    });
    // Drain the body so latency reflects a complete response.
    await res.arrayBuffer().catch(() => undefined);
    const latency = performance.now() - t0;
    const ok = svc.expect_status.includes(res.status);
    return {
      service: svc.name,
      ts: startedAt,
      ok,
      status_code: res.status,
      latency_ms: Math.round(latency * 100) / 100,
      error: ok ? null : `unexpected status ${res.status}`,
      attempts: 1,
    };
  } catch (err) {
    const latency = performance.now() - t0;
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      service: svc.name,
      ts: startedAt,
      ok: false,
      status_code: null,
      latency_ms: Math.round(latency * 100) / 100,
      error: aborted ? `timeout after ${svc.timeout_ms}ms` : describeError(err),
      attempts: 1,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes a service with failure confirmation: a failed attempt is retried up
 * to `svc.retries` times (with `svc.retry_delay_ms` between attempts) before
 * it counts as a failure. Probing from a single vantage point, a one-off
 * transient (DNS blip, runner egress reset, cold-start hiccup) is otherwise
 * indistinguishable from real downtime and silently burns error budget.
 * The recorded result is the last attempt, with the total attempt count.
 */
export async function probeService(svc: ServiceConfig): Promise<ProbeResult> {
  const maxAttempts = svc.retries + 1;
  for (let attempt = 1; ; attempt++) {
    const result = await probeOnce(svc);
    result.attempts = attempt;
    if (result.ok || attempt >= maxAttempts) return result;
    if (svc.retry_delay_ms > 0) {
      await new Promise((r) => setTimeout(r, svc.retry_delay_ms));
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

// Set when the DB predates migration 0002 (no attempts column), so probing
// keeps working while a deploy is ahead of the migration.
let attemptsColumnMissing = false;

/** Probes every service concurrently and persists all results in one insert. */
export async function runProbeBatch(
  services: ServiceConfig[]
): Promise<ProbeResult[]> {
  const results = await Promise.all(services.map((s) => probeService(s)));
  if (results.length === 0) return results;

  if (!attemptsColumnMissing) {
    try {
      await sql`INSERT INTO probe_results ${sql(
        results,
        "service",
        "ts",
        "ok",
        "status_code",
        "latency_ms",
        "error",
        "attempts"
      )}`;
      return results;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      attemptsColumnMissing = true;
    }
  }

  await sql`INSERT INTO probe_results ${sql(
    results,
    "service",
    "ts",
    "ok",
    "status_code",
    "latency_ms",
    "error"
  )}`;
  return results;
}

function isUndefinedColumn(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42703";
}
