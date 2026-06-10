import test from "node:test";
import assert from "node:assert/strict";
import { assembleIncidents, type IncidentRow, type LatestProbe } from "../src/lib/incidents";

function row(
  service: string,
  start: string,
  end: string,
  failed = 3
): IncidentRow {
  return {
    service,
    started_at: new Date(start),
    last_failure_at: new Date(end),
    failed_probes: failed,
    sample_error: "timeout after 5000ms",
  };
}

test("assembleIncidents computes duration between first and last failure", () => {
  const [inc] = assembleIncidents(
    [row("api", "2026-06-01T10:00:00Z", "2026-06-01T10:45:00Z")],
    [{ service: "api", ts: new Date("2026-06-10T00:00:00Z"), ok: true }]
  );

  assert.equal(inc.durationMinutes, 45);
  assert.equal(inc.failedProbes, 3);
  assert.equal(inc.ongoing, false);
  assert.equal(inc.startedAt, "2026-06-01T10:00:00.000Z");
});

test("assembleIncidents marks an incident ongoing when it contains the service's latest probe and that probe failed", () => {
  const lastFailure = new Date("2026-06-10T19:45:00Z");
  const [inc] = assembleIncidents(
    [row("api", "2026-06-10T19:15:00Z", lastFailure.toISOString())],
    [{ service: "api", ts: lastFailure, ok: false }]
  );

  assert.equal(inc.ongoing, true);
});

test("assembleIncidents does not mark ongoing when a newer probe succeeded", () => {
  const incidents: LatestProbe[] = [
    { service: "api", ts: new Date("2026-06-10T20:00:00Z"), ok: true },
  ];
  const [inc] = assembleIncidents(
    [row("api", "2026-06-10T19:15:00Z", "2026-06-10T19:45:00Z")],
    incidents
  );

  assert.equal(inc.ongoing, false);
});
