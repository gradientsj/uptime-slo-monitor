import { renderMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prometheus scrape target. Plain-text exposition computed from probe data. */
export async function GET(): Promise<Response> {
  const body = await renderMetrics();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
