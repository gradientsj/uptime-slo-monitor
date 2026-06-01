export type ProbeAuthResult = "authorized" | "unauthorized" | "missing_secret";

/**
 * Authorizes scheduled probe invocations.
 *
 * Production deployments should set CRON_SECRET. Vercel Cron and the
 * probe-cron GitHub workflow both send Authorization: Bearer <CRON_SECRET>.
 */
export function authorizeProbeRequest(
  req: Request,
  secret = process.env.CRON_SECRET,
  nodeEnv = process.env.NODE_ENV
): ProbeAuthResult {
  if (!secret) {
    return nodeEnv === "production" ? "missing_secret" : "authorized";
  }

  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const token = url.searchParams.get("token");

  return auth === `Bearer ${secret}` || token === secret
    ? "authorized"
    : "unauthorized";
}
