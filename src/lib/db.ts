import postgres from "postgres";

/**
 * Lazily-initialised shared `postgres` client. Works in three environments:
 *  - Vercel serverless (Node runtime) against a Neon/Vercel pooled endpoint
 *  - the long-running GKE worker
 *  - local docker-compose Postgres
 *
 * The client is created on first use (not at import time) so that building the
 * app — or importing a module that re-exports `sql` — doesn't require
 * DATABASE_URL to be present. We cache it on globalThis so Next.js hot-reload
 * and reused lambda containers don't open a new pool per invocation.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    // Keep the pool tiny: serverless functions are single-flight and the
    // pooled endpoint (Neon/PgBouncer) fans out for us.
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required for transaction-pooling endpoints (PgBouncer/Neon)
    onnotice: () => {},
  });
}

function getClient(): ReturnType<typeof postgres> {
  if (!globalThis.__sql) globalThis.__sql = create();
  return globalThis.__sql;
}

/**
 * Proxy that forwards both tagged-template calls (`sql\`...\``) and method/
 * property access (`sql.begin`, `sql.unsafe`, `sql.end`, `sql(rows, ...)`) to a
 * lazily-created client.
 */
export const sql = new Proxy(function () {} as unknown as ReturnType<typeof postgres>, {
  apply(_target, _thisArg, args: unknown[]) {
    // @ts-expect-error postgres client is callable as both tag and helper
    return getClient()(...args);
  },
  get(_target, prop) {
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
