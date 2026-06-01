import { NextResponse } from "next/server";
import { getService } from "@/lib/config";
import { evaluateSlo } from "@/lib/slo";
import { evaluateAlerts } from "@/lib/alerts";
import { history, recentProbes } from "@/lib/sli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-service detail: SLO report, alert policy evaluations, and 24h history. */
export async function GET(
  req: Request,
  { params }: { params: { name: string } }
): Promise<NextResponse> {
  const svc = getService(params.name);
  if (!svc) {
    return NextResponse.json({ error: "unknown service" }, { status: 404 });
  }

  const url = new URL(req.url);
  const windowSeconds = Number(url.searchParams.get("window") ?? 86400);

  const [slo, alert, buckets, recent] = await Promise.all([
    evaluateSlo(svc),
    evaluateAlerts(svc),
    history(svc.name, windowSeconds, 48),
    recentProbes(svc.name, 100),
  ]);

  return NextResponse.json(
    {
      service: { name: svc.name, description: svc.description, url: svc.url },
      slo,
      alert,
      history: buckets,
      recent,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
