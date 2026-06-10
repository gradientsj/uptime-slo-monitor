import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePolicy,
  summarizeAlertStatus,
  type AlertPolicy,
  type PolicyEvaluation,
} from "../src/lib/alerts";
import type { ServiceConfig } from "../src/lib/config";
import type { WindowStats } from "../src/lib/sli";

const service: ServiceConfig = {
  name: "api",
  url: "https://example.com",
  method: "GET",
  expect_status: [200],
  timeout_ms: 1000,
  retries: 0,
  retry_delay_ms: 0,
  window_days: 30,
  availability_target: 0.99,
  latency_percentile: 95,
  latency_target_ms: 800,
};

const policy: AlertPolicy = {
  name: "test-burn",
  severity: "ticket",
  burnRateThreshold: 2,
  longWindowSeconds: 3600,
  shortWindowSeconds: 300,
  label: "1h/5m @ 2x",
  minLongSamples: 3,
};

function stats(total: number, failures: number): WindowStats {
  return {
    total,
    failures,
    availability: total === 0 ? 1 : (total - failures) / total,
    errorRate: total === 0 ? 0 : failures / total,
    latencyPercentileMs: null,
    avgLatencyMs: null,
  };
}

test("evaluatePolicy fires only when both windows exceed threshold with enough samples", () => {
  const ev = evaluatePolicy(service, policy, stats(100, 3), stats(10, 1));

  assert.equal(ev.firing, true);
  assert.ok(ev.longBurnRate >= 2);
  assert.ok(ev.shortBurnRate >= 2);
});

test("evaluatePolicy suppresses alerts when the short window has recovered", () => {
  const ev = evaluatePolicy(service, policy, stats(100, 3), stats(10, 0));

  assert.equal(ev.firing, false);
});

test("evaluatePolicy suppresses alerts until the long window has enough samples", () => {
  const ev = evaluatePolicy(service, policy, stats(2, 2), stats(2, 2));

  assert.equal(ev.firing, false);
});

test("summarizeAlertStatus reports page as the highest active severity", () => {
  const ticket: PolicyEvaluation = evaluatePolicy(
    service,
    policy,
    stats(100, 3),
    stats(10, 1)
  );
  const page: PolicyEvaluation = {
    ...ticket,
    policy: "page-burn",
    severity: "page",
  };

  const summary = summarizeAlertStatus("api", [ticket, page]);

  assert.equal(summary.service, "api");
  assert.equal(summary.firing, true);
  assert.equal(summary.highestSeverity, "page");
});
