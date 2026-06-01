-- =============================================================================
-- Uptime & SLO Monitor — initial schema
-- =============================================================================

-- Raw probe results. One row per (service, probe attempt).
CREATE TABLE IF NOT EXISTS probe_results (
  id          BIGSERIAL PRIMARY KEY,
  service     TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok          BOOLEAN     NOT NULL,
  status_code INTEGER,
  latency_ms  DOUBLE PRECISION,
  error       TEXT
);

-- Hot path for SLI windows and the status page: read recent rows per service.
CREATE INDEX IF NOT EXISTS idx_probe_results_service_ts
  ON probe_results (service, ts DESC);

-- Used by retention pruning.
CREATE INDEX IF NOT EXISTS idx_probe_results_ts
  ON probe_results (ts);

-- Alert event log: an event is written whenever a service's alert state
-- transitions (e.g. ok -> firing or firing -> resolved) for a given policy.
CREATE TABLE IF NOT EXISTS alert_events (
  id         BIGSERIAL PRIMARY KEY,
  service    TEXT        NOT NULL,
  policy     TEXT        NOT NULL,           -- e.g. "fast-burn", "slow-burn"
  severity   TEXT        NOT NULL,           -- "page" | "ticket"
  state      TEXT        NOT NULL,           -- "firing" | "resolved"
  burn_rate  DOUBLE PRECISION,
  long_window  TEXT,
  short_window TEXT,
  message    TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_service_ts
  ON alert_events (service, ts DESC);

-- Tracks the latest known alert state per (service, policy) so the evaluator
-- only logs transitions instead of an event every tick.
CREATE TABLE IF NOT EXISTS alert_state (
  service    TEXT        NOT NULL,
  policy     TEXT        NOT NULL,
  state      TEXT        NOT NULL,           -- "firing" | "ok"
  since      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, policy)
);
