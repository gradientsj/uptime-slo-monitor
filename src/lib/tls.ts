import { connect } from "node:tls";
import type { ServiceConfig } from "./config";
import { sql } from "./db";

/**
 * TLS certificate expiry monitoring. Each probe tick refreshes a per-service
 * row in tls_status (cheap: one handshake per https service). Read paths and
 * upserts tolerate the table not existing yet (migration 0003), mirroring the
 * probe_results.attempts strategy, so a deploy can precede the migration.
 */

export type TlsCheck = {
  service: string;
  host: string;
  not_after: Date | null;
  issuer: string | null;
  error: string | null;
};

export type TlsCardModel = {
  daysRemaining: number | null;
  notAfter: string | null; // ISO
  issuer: string | null;
  error: string | null;
  checkedAt: string; // ISO
};

const HANDSHAKE_TIMEOUT_MS = 5000;

/** Inspects the certificate of an https service. Resolves null for non-https. */
export function checkTls(svc: ServiceConfig): Promise<TlsCheck | null> {
  let url: URL;
  try {
    url = new URL(svc.url);
  } catch {
    return Promise.resolve(null);
  }
  if (url.protocol !== "https:") return Promise.resolve(null);
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;

  return new Promise((resolve) => {
    let settled = false;
    const done = (check: TlsCheck) => {
      if (settled) return;
      settled = true;
      resolve(check);
    };
    const fail = (error: string) =>
      done({ service: svc.name, host, not_after: null, issuer: null, error });

    try {
      // rejectUnauthorized:false so an already-expired or mis-chained cert is
      // still inspectable — surfacing it is the whole point of the check.
      const socket = connect({ host, port, servername: host, rejectUnauthorized: false });
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
      socket.on("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const notAfter = cert?.valid_to ? new Date(cert.valid_to) : null;
        done({
          service: svc.name,
          host,
          not_after: notAfter && !isNaN(notAfter.getTime()) ? notAfter : null,
          issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null,
          error: null,
        });
      });
      socket.on("timeout", () => {
        socket.destroy();
        fail(`handshake timeout after ${HANDSHAKE_TIMEOUT_MS}ms`);
      });
      socket.on("error", (err) => fail(err.message));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });
}

export function daysRemaining(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
}

// Set when the DB predates migration 0003 (no tls_status table).
let tlsTableMissing = false;

/** Checks every https service concurrently and upserts the results. */
export async function recordTlsStatuses(
  services: ServiceConfig[]
): Promise<number> {
  if (tlsTableMissing) return 0;
  const checks = (await Promise.all(services.map(checkTls))).filter(
    (c): c is TlsCheck => c !== null
  );
  if (checks.length === 0) return 0;

  try {
    await sql`
      INSERT INTO tls_status ${sql(checks, "service", "host", "not_after", "issuer", "error")}
      ON CONFLICT (service) DO UPDATE SET
        host = EXCLUDED.host,
        not_after = EXCLUDED.not_after,
        issuer = EXCLUDED.issuer,
        error = EXCLUDED.error,
        checked_at = now()
    `;
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    tlsTableMissing = true;
    return 0;
  }
  return checks.length;
}

/** Latest TLS status per service, keyed by service name. */
export async function readTlsStatuses(): Promise<Map<string, TlsCardModel>> {
  if (tlsTableMissing) return new Map();
  try {
    const rows = await sql<
      {
        service: string;
        not_after: Date | null;
        issuer: string | null;
        error: string | null;
        checked_at: Date;
      }[]
    >`SELECT service, not_after, issuer, error, checked_at FROM tls_status`;
    const now = new Date();
    return new Map(
      rows.map((r) => [
        r.service,
        {
          daysRemaining: r.not_after ? daysRemaining(r.not_after, now) : null,
          notAfter: r.not_after ? r.not_after.toISOString() : null,
          issuer: r.issuer,
          error: r.error,
          checkedAt: r.checked_at.toISOString(),
        },
      ])
    );
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    tlsTableMissing = true;
    return new Map();
  }
}

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42P01";
}
