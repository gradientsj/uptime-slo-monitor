import { getDashboard, type DashboardModel } from "@/lib/queries";
import Dashboard from "./dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  let initial: DashboardModel | null = null;
  let error: string | null = null;
  try {
    initial = await getDashboard();
  } catch (err) {
    error = String(err);
  }

  return (
    <div className="wrap">
      <header className="site">
        <div>
          <h1>{process.env.NEXT_PUBLIC_SITE_NAME ?? "Uptime & SLO Monitor"}</h1>
          <div className="subtitle">
            Availability &amp; latency SLOs, error-budget burn, and
            multi-window multi-burn-rate alerts for live endpoints.
          </div>
        </div>
        <div className="subtitle">
          <a href={process.env.NEXT_PUBLIC_OWNER_URL ?? "https://stanleyjacob.dev"}>
            stanleyjacob.dev
          </a>
        </div>
      </header>

      {error ? (
        <div className="banner down">
          <span className="dot down" /> Could not load monitor data — the
          database may be unreachable or not yet migrated.
        </div>
      ) : (
        <Dashboard initial={initial!} />
      )}
    </div>
  );
}
