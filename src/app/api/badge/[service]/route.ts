import { getService } from "@/lib/config";
import { evaluateSlo } from "@/lib/slo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shields-style SVG uptime badge, embeddable in READMEs:
 *
 *   ![uptime](https://<deployment>/api/badge/github-api)
 *
 * Shows availability over the service's SLO window, green when the SLO is
 * met, red when not, gray when there is no probe data yet. `?label=` overrides
 * the left-hand text.
 */
export async function GET(
  req: Request,
  { params }: { params: { service: string } }
): Promise<Response> {
  const svc = getService(params.service);
  if (!svc) {
    return new Response(renderBadge("uptime", "unknown service", COLORS.gray), {
      status: 404,
      headers: SVG_HEADERS,
    });
  }

  const url = new URL(req.url);
  const report = await evaluateSlo(svc);
  const label = url.searchParams.get("label") ?? `${svc.name} ${report.windowDays}d`;

  const value =
    report.total === 0 ? "no data" : `${(report.availability * 100).toFixed(2)}%`;
  const color =
    report.total === 0
      ? COLORS.gray
      : report.availabilityMet
        ? COLORS.green
        : COLORS.red;

  return new Response(renderBadge(label, value, color), {
    headers: SVG_HEADERS,
  });
}

const SVG_HEADERS = {
  "content-type": "image/svg+xml; charset=utf-8",
  // Let CDNs serve it for 5 minutes; uptime over a 30d window moves slowly.
  "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
};

const COLORS = {
  green: "#2ea043",
  red: "#f85149",
  gray: "#6e7681",
};

function renderBadge(label: string, value: string, color: string): string {
  // Approximate Verdana 11px text width; close enough for badge layout.
  const textWidth = (s: string) => Math.round(s.length * 6.6);
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 12;
  const w = lw + vw;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#555"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}
