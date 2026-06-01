// k6 load test for the probe/metrics path.
//
// Verifies that the latency-sensitive read paths the prober and scrapers hit
// (/api/metrics computed from probe data, and /api/status) stay within their
// latency budget under concurrency. Fails (non-zero exit) if the budget is
// breached, so it can gate CI.
//
//   BASE_URL=http://localhost:3000 BUDGET_MS=800 VUS=50 k6 run loadtest/probe_load.js
//
import http from "k6/http";
import { check, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const BUDGET_MS = Number(__ENV.BUDGET_MS || 800);
const VUS = Number(__ENV.VUS || 50);

const errorRate = new Rate("path_errors");
const metricsLatency = new Trend("metrics_latency_ms", true);
const statusLatency = new Trend("status_latency_ms", true);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: VUS },
        { duration: "40s", target: VUS },
        { duration: "10s", target: 0 },
      ],
      gracefulStop: "10s",
    },
  },
  thresholds: {
    // The core assertion: p95 of the probe/read path must stay under budget.
    http_req_duration: [`p(95)<${BUDGET_MS}`],
    metrics_latency_ms: [`p(95)<${BUDGET_MS}`],
    status_latency_ms: [`p(95)<${BUDGET_MS}`],
    path_errors: ["rate<0.01"],
  },
};

export default function () {
  group("metrics", () => {
    const res = http.get(`${BASE_URL}/api/metrics`);
    metricsLatency.add(res.timings.duration);
    const ok = check(res, {
      "metrics 200": (r) => r.status === 200,
      "metrics is prometheus text": (r) =>
        (r.headers["Content-Type"] || "").includes("text/plain"),
    });
    errorRate.add(!ok);
  });

  group("status", () => {
    const res = http.get(`${BASE_URL}/api/status`);
    statusLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "status has services": (r) => {
        try {
          return Array.isArray(JSON.parse(r.body).services);
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!ok);
  });
}
