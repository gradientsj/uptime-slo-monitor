/**
 * Seeds synthetic probe history so the status page and SLOs have data to show
 * immediately (useful for demos / first deploy). Safe to run repeatedly.
 *
 *   DATABASE_URL=... npm run db:seed -- [days]
 *
 * Generates one probe per service per minute for the last N days (default 2),
 * with a realistic baseline latency and occasional injected incidents.
 */
import postgres from "postgres";
import { loadServices } from "../src/lib/config";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const days = Number(process.argv[2] ?? 2);
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

// Deterministic PRNG so seeds are reproducible.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const { services } = loadServices();
  const stepMs = 60_000;
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;

  for (let si = 0; si < services.length; si++) {
    const svc = services[si];
    const rand = mulberry32(0xc0ffee + si * 7919);
    const baseLatency = 80 + si * 25;
    const rows: {
      service: string;
      ts: Date;
      ok: boolean;
      status_code: number | null;
      latency_ms: number | null;
      error: string | null;
    }[] = [];

    // A couple of injected incidents per service.
    const incidents: [number, number][] = [];
    const numIncidents = Math.floor(rand() * 3);
    for (let k = 0; k < numIncidents; k++) {
      const s = start + rand() * (now - start);
      incidents.push([s, s + (5 + rand() * 40) * 60_000]);
    }
    const inIncident = (t: number) => incidents.some(([a, b]) => t >= a && t <= b);

    for (let t = start; t <= now; t += stepMs) {
      const incident = inIncident(t);
      const fail = incident ? rand() < 0.6 : rand() < 0.004;
      const latency = incident
        ? baseLatency * (3 + rand() * 5)
        : baseLatency * (0.7 + rand() * 0.8);
      rows.push({
        service: svc.name,
        ts: new Date(t),
        ok: !fail,
        status_code: fail ? (rand() < 0.5 ? 503 : 500) : svc.expect_status[0],
        latency_ms: fail && rand() < 0.4 ? null : Math.round(latency),
        error: fail ? "synthetic incident" : null,
      });
    }

    // Insert in chunks to keep statements small.
    const chunk = 1000;
    for (let i = 0; i < rows.length; i += chunk) {
      await sql`INSERT INTO probe_results ${sql(
        rows.slice(i, i + chunk),
        "service",
        "ts",
        "ok",
        "status_code",
        "latency_ms",
        "error"
      )}`;
    }
    console.log(`+ ${svc.name}: ${rows.length} rows`);
  }

  console.log("seed complete");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
