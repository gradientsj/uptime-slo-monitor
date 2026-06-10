import test from "node:test";
import assert from "node:assert/strict";
import { loadServices } from "../src/lib/config";

const originalConfigPath = process.env.SERVICES_CONFIG;

test.afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.SERVICES_CONFIG;
  } else {
    process.env.SERVICES_CONFIG = originalConfigPath;
  }
  loadServices(true);
});

test("loadServices merges defaults with per-service overrides", () => {
  process.env.SERVICES_CONFIG = "tests/fixtures/services.valid.yaml";

  const { services } = loadServices(true);

  assert.equal(services.length, 2);
  assert.deepEqual(services[0], {
    name: "api-one",
    description: "Primary test API",
    url: "https://example.com/api-one",
    method: "POST",
    expect_status: [202],
    timeout_ms: 2500,
    retries: 1,
    retry_delay_ms: 10,
    window_days: 7,
    availability_target: 0.98,
    latency_percentile: 90,
    latency_target_ms: 500,
  });
  assert.equal(services[1].method, "HEAD");
  assert.deepEqual(services[1].expect_status, [200, 201]);
  assert.equal(services[1].availability_target, 0.995);
  assert.equal(services[1].latency_target_ms, 500);
  assert.equal(services[1].retries, 0);
  assert.equal(services[1].retry_delay_ms, 10);
});

test("loadServices rejects duplicate service names", () => {
  process.env.SERVICES_CONFIG = "tests/fixtures/services.duplicate.yaml";

  assert.throws(() => loadServices(true), /duplicate service name: duplicate-api/);
});
