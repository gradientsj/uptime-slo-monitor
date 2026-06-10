import test from "node:test";
import assert from "node:assert/strict";
import { buildSloReport, burnRate } from "../src/lib/slo";
import type { ServiceConfig } from "../src/lib/config";
import type { WindowStats } from "../src/lib/sli";

const service: ServiceConfig = {
  name: "api",
  description: "Test API",
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

function closeTo(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${actual} should be close to ${expected}`
  );
}

test("burnRate divides observed error rate by the availability error budget", () => {
  closeTo(burnRate(0.02, 0.99), 2);
  assert.equal(burnRate(0, 1), 0);
  assert.equal(burnRate(0.01, 1), Infinity);
});

test("buildSloReport marks healthy no-data windows as not failing", () => {
  const stats: WindowStats = {
    total: 0,
    failures: 0,
    availability: 1,
    errorRate: 0,
    latencyPercentileMs: null,
    avgLatencyMs: null,
  };

  const report = buildSloReport(service, stats);

  assert.equal(report.availabilityMet, true);
  assert.equal(report.latencyMet, true);
  assert.equal(report.budgetConsumedRatio, 0);
  assert.equal(report.budgetRemainingRatio, 1);
  assert.equal(report.latencyP95Ms, null);
});

test("buildSloReport flags exhausted availability budget and latency breach", () => {
  const stats: WindowStats = {
    total: 100,
    failures: 2,
    availability: 0.98,
    errorRate: 0.02,
    latencyPercentileMs: 901,
    avgLatencyMs: 300,
  };

  const report = buildSloReport(service, stats);

  assert.equal(report.availabilityMet, false);
  assert.equal(report.latencyMet, false);
  closeTo(report.budgetConsumedRatio, 2);
  assert.equal(report.budgetRemainingRatio, 0);
  assert.equal(report.failures, 2);
});
