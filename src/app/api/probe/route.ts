import { NextResponse } from "next/server";
import { loadServices } from "@/lib/config";
import { runProbeBatch } from "@/lib/probe";
import { evaluateAlerts, persistAlertTransitions } from "@/lib/alerts";
import { pruneOldData } from "@/lib/maintenance";
import { authorizeProbeRequest } from "@/lib/probeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Probe tick. Driven on a schedule by GitHub Actions (every ~5 min) and/or
 * Vercel Cron. Probes every service, persists results, re-evaluates alert
 * policies, and prunes old data. Protected by CRON_SECRET.
 *
 *   GET/POST /api/probe   with  Authorization: Bearer <CRON_SECRET>
 *                          or   ?token=<CRON_SECRET>
 */
async function handle(req: Request): Promise<NextResponse> {
  const auth = authorizeProbeRequest(req);
  if (auth === "missing_secret") {
    return NextResponse.json(
      { error: "CRON_SECRET is required in production" },
      { status: 503 }
    );
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const { services } = loadServices();
  const results = await runProbeBatch(services);

  // Re-evaluate alerts for every service and record any state transitions.
  const transitions: unknown[] = [];
  for (const svc of services) {
    const status = await evaluateAlerts(svc);
    const t = await persistAlertTransitions(status);
    for (const x of t) transitions.push({ service: svc.name, ...x });
  }

  // Opportunistic retention prune.
  let pruned = 0;
  try {
    pruned = await pruneOldData(Number(process.env.RETENTION_DAYS ?? 45));
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({
    ok: true,
    probed: results.length,
    failures: results.filter((r) => !r.ok).length,
    transitions,
    pruned,
    durationMs: Date.now() - startedAt,
  });
}

export const GET = handle;
export const POST = handle;
