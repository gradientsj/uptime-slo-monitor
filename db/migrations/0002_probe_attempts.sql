-- =============================================================================
-- Probe failure confirmation: record how many fetch attempts a probe made.
--
-- attempts = 1 means the probe settled on the first try; a failed row with
-- attempts = N means the endpoint failed N consecutive times before being
-- recorded as down (see probeService in src/lib/probe.ts). Pre-existing rows
-- backfill to 1. The insert path tolerates this column being absent, so the
-- app can deploy before this migration runs.
-- =============================================================================

ALTER TABLE probe_results
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
