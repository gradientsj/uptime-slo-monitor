import test from "node:test";
import assert from "node:assert/strict";
import { fillDailyCells, overallAvailability } from "../src/lib/uptime";
import type { Bucket } from "../src/lib/sli";

const now = new Date("2026-06-10T20:00:00Z");

function bucket(date: string, total: number, failures: number): Bucket {
  return {
    bucket: `${date}T00:00:00.000Z`,
    total,
    failures,
    availability: total === 0 ? 1 : (total - failures) / total,
    p95_ms: 120,
  };
}

test("fillDailyCells returns a dense window ending today with gaps as empty cells", () => {
  const cells = fillDailyCells(
    [bucket("2026-06-10", 96, 0), bucket("2026-06-08", 96, 3)],
    5,
    now
  );

  assert.equal(cells.length, 5);
  assert.deepEqual(
    cells.map((c) => c.date),
    ["2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"]
  );
  // Days with no probes are explicit no-data cells, not zeros-as-perfect.
  assert.equal(cells[0].availability, null);
  assert.equal(cells[3].availability, null);
  assert.equal(cells[2].failures, 3);
  assert.equal(cells[4].availability, 1);
});

test("overallAvailability weights by probe count and is null with no data", () => {
  const cells = fillDailyCells(
    [bucket("2026-06-09", 100, 10), bucket("2026-06-10", 300, 0)],
    3,
    now
  );

  // 390 successes over 400 probes — not the average of 90% and 100%.
  assert.equal(overallAvailability(cells), 0.975);
  assert.equal(overallAvailability(fillDailyCells([], 3, now)), null);
});
