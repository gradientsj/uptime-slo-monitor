import { loadServices } from "./config";
import { sql } from "./db";
import { evaluateSlo } from "./slo";
import { evaluateAlerts } from "./alerts";
import { burnRate } from "./slo";
import { windowStats } from "./sli";
import { readTlsStatuses } from "./tls";

/**
 * Renders the Prometheus text exposition for all services. Everything is
 * computed from probe_results at scrape time, so the endpoint is stateless and
 * safe to scrape from Prometheus (docker-compose / GKE) or Grafana Agent.
 */

type Line = { help: string; type: string; name: string; samples: string[] };

function metric(name: string, help: string, type: string): Line {
  return { name, help, type, samples: [] };
}

function lbl(labels: Record<string, string | number>): string {
  const inner = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, "\\$1")}"`)
    .join(",");
  return `{${inner}}`;
}

function render(lines: Line[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.samples.length === 0) continue;
    out.push(`# HELP ${l.name} ${l.help}`);
    out.push(`# TYPE ${l.name} ${l.type}`);
    out.push(...l.samples);
  }
  return out.join("\n") + "\n";
}

export async function renderMetrics(): Promise<string> {
  const { services } = loadServices();

  const up = metric("probe_up", "1 if the most recent probe succeeded, else 0", "gauge");
  const lastLatency = metric(
    "probe_last_latency_milliseconds",
    "Latency of the most recent probe",
    "gauge"
  );
  const availability = metric(
    "slo_availability_ratio",
    "Observed availability over the SLO window",
    "gauge"
  );
  const availabilityTarget = metric(
    "slo_availability_target_ratio",
    "Configured availability SLO target",
    "gauge"
  );
  const latencyP95 = metric(
    "slo_latency_p95_milliseconds",
    "Observed p95 latency over the SLO window",
    "gauge"
  );
  const latencyTarget = metric(
    "slo_latency_target_milliseconds",
    "Configured latency SLO target",
    "gauge"
  );
  const budgetRemaining = metric(
    "slo_error_budget_remaining_ratio",
    "Fraction of the availability error budget remaining (0..1)",
    "gauge"
  );
  const burn = metric(
    "slo_burn_rate",
    "Error-budget burn rate over the labelled window",
    "gauge"
  );
  const probeTotal = metric(
    "probe_results_total",
    "Probe results recorded over the SLO window",
    "gauge"
  );
  const probeFailures = metric(
    "probe_failures_total",
    "Failed probe results over the SLO window",
    "gauge"
  );
  const alertFiring = metric(
    "alert_firing",
    "1 if the alert policy is currently firing for the service",
    "gauge"
  );
  const tlsDays = metric(
    "tls_days_remaining",
    "Days until the service TLS certificate expires",
    "gauge"
  );

  const tlsByService = await readTlsStatuses();

  // Per-service last probe (single round-trip).
  const lastRows = await sql<
    { service: string; ok: boolean; latency_ms: number | null }[]
  >`
    SELECT DISTINCT ON (service) service, ok, latency_ms
    FROM probe_results
    ORDER BY service, ts DESC
  `;
  const lastByService = new Map(lastRows.map((r) => [r.service, r]));

  for (const svc of services) {
    const l = lbl({ service: svc.name });
    const last = lastByService.get(svc.name);
    up.samples.push(`probe_up${l} ${last ? (last.ok ? 1 : 0) : 0}`);
    if (last?.latency_ms != null) {
      lastLatency.samples.push(`probe_last_latency_milliseconds${l} ${last.latency_ms}`);
    }

    const report = await evaluateSlo(svc);
    availability.samples.push(`slo_availability_ratio${l} ${report.availability}`);
    availabilityTarget.samples.push(
      `slo_availability_target_ratio${l} ${report.availabilityTarget}`
    );
    if (report.latencyP95Ms != null) {
      latencyP95.samples.push(`slo_latency_p95_milliseconds${l} ${report.latencyP95Ms}`);
    }
    latencyTarget.samples.push(`slo_latency_target_milliseconds${l} ${report.latencyTargetMs}`);
    budgetRemaining.samples.push(
      `slo_error_budget_remaining_ratio${l} ${report.budgetRemainingRatio}`
    );
    probeTotal.samples.push(`probe_results_total${l} ${report.total}`);
    probeFailures.samples.push(`probe_failures_total${l} ${report.failures}`);

    // Burn rate over a couple of representative windows.
    for (const [name, secs] of [
      ["1h", 3600],
      ["6h", 21600],
    ] as const) {
      const stats = await windowStats(svc.name, secs, svc.latency_percentile);
      const br = burnRate(stats.errorRate, svc.availability_target);
      burn.samples.push(`slo_burn_rate${lbl({ service: svc.name, window: name })} ${isFinite(br) ? br : 0}`);
    }

    const alerts = await evaluateAlerts(svc);
    for (const ev of alerts.evaluations) {
      alertFiring.samples.push(
        `alert_firing${lbl({ service: svc.name, policy: ev.policy, severity: ev.severity })} ${ev.firing ? 1 : 0}`
      );
    }

    const tls = tlsByService.get(svc.name);
    if (tls?.daysRemaining != null) {
      tlsDays.samples.push(`tls_days_remaining${l} ${tls.daysRemaining}`);
    }
  }

  return render([
    up,
    lastLatency,
    availability,
    availabilityTarget,
    latencyP95,
    latencyTarget,
    budgetRemaining,
    burn,
    probeTotal,
    probeFailures,
    alertFiring,
    tlsDays,
  ]);
}
