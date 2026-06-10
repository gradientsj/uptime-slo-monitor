-- =============================================================================
-- TLS certificate expiry monitoring: latest handshake result per service.
--
-- Refreshed on every probe tick for https services (src/lib/tls.ts). The
-- read/write paths tolerate this table being absent, so the app can deploy
-- before this migration runs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tls_status (
  service    TEXT PRIMARY KEY,
  host       TEXT,
  not_after  TIMESTAMPTZ,                 -- certificate expiry; NULL if unknown
  issuer     TEXT,
  error      TEXT,                        -- handshake error, NULL on success
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
