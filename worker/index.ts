/**
 * Standalone probe worker for long-running environments (GKE / docker-compose).
 *
 * Responsibilities:
 *   - probe every service on a cron schedule (PROBE_SCHEDULE, default 1m),
 *   - evaluate alert policies and persist state transitions,
 *   - prune data past the retention window,
 *   - expose GET /metrics (Prometheus) and GET /healthz for in-cluster scraping
 *     and k8s liveness/readiness probes.
 *
 * This shares the exact same lib/ code as the Vercel API routes, so SLO/alert
 * math is identical regardless of where probing runs.
 */
import { createServer } from "node:http";
import cron from "node-cron";
import { loadServices } from "../src/lib/config";
import { runProbeBatch } from "../src/lib/probe";
import { evaluateAlerts, persistAlertTransitions } from "../src/lib/alerts";
import { renderMetrics } from "../src/lib/metrics";
import { pruneOldData } from "../src/lib/maintenance";
import { sql } from "../src/lib/db";

const PORT = Number(process.env.PORT ?? 8080);
const SCHEDULE = process.env.PROBE_SCHEDULE ?? "* * * * *";
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 45);

let lastTickAt = 0;
let lastTickOk = false;
let running = false;

async function tick() {
  if (running) {
    log("previous tick still running; skipping");
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    const { services } = loadServices();
    const results = await runProbeBatch(services);
    let transitions = 0;
    for (const svc of services) {
      const status = await evaluateAlerts(svc);
      const t = await persistAlertTransitions(status);
      transitions += t.length;
      for (const x of t) {
        log(`alert ${svc.name}/${x.policy}: ${x.from} -> ${x.to}`);
      }
    }
    const failures = results.filter((r) => !r.ok).length;
    lastTickOk = true;
    lastTickAt = Date.now();
    log(
      `tick ok: probed=${results.length} failures=${failures} transitions=${transitions} (${
        Date.now() - t0
      }ms)`
    );
  } catch (err) {
    lastTickOk = false;
    log(`tick error: ${String(err)}`);
  } finally {
    running = false;
  }
}

// Hourly retention prune.
cron.schedule("0 * * * *", async () => {
  try {
    const pruned = await pruneOldData(RETENTION_DAYS);
    log(`pruned ${pruned} old probe rows (retention ${RETENTION_DAYS}d)`);
  } catch (err) {
    log(`prune error: ${String(err)}`);
  }
});

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  try {
    if (url.startsWith("/metrics")) {
      const body = await renderMetrics();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(body);
      return;
    }
    if (url.startsWith("/healthz")) {
      await sql`SELECT 1`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          lastTickOk,
          lastTickAgoSec: lastTickAt ? Math.round((Date.now() - lastTickAt) / 1000) : null,
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "degraded", detail: String(err) }));
  }
});

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [worker] ${msg}`);
}

async function main() {
  if (!cron.validate(SCHEDULE)) {
    throw new Error(`invalid PROBE_SCHEDULE: ${SCHEDULE}`);
  }
  server.listen(PORT, () => log(`metrics/health server on :${PORT}`));
  cron.schedule(SCHEDULE, tick);
  log(`scheduled probes: "${SCHEDULE}"`);
  // Run one tick immediately so there's data without waiting for the first cron.
  await tick();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close();
    sql.end({ timeout: 5 }).finally(() => process.exit(0));
  });
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  process.exit(1);
});
