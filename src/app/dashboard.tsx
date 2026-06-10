"use client";

import { useEffect, useState } from "react";
import type { DashboardModel, ServiceCardModel } from "@/lib/queries";
import type { DayCell } from "@/lib/uptime";
import type { Incident } from "@/lib/incidents";

const POLL_MS = 30_000;
// Newest probe older than this ⇒ show the stale-data notice. Generous enough
// for GitHub Actions cron jitter, tight enough to catch a dead prober.
const STALE_AFTER_MINUTES = 60;

export default function Dashboard({ initial }: { initial: DashboardModel }) {
  const [data, setData] = useState<DashboardModel>(initial);
  const [updatedAt, setUpdatedAt] = useState<string>(initial.generatedAt);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as DashboardModel;
        if (alive) {
          setData(json);
          setUpdatedAt(json.generatedAt);
        }
      } catch {
        /* keep last good data */
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const { summary, services, incidents, recentAlerts } = data;
  const overall: ServiceCardModel["state"] =
    summary.down > 0 ? "down" : summary.degraded > 0 ? "degraded" : "up";

  return (
    <>
      <div className={`banner ${overall}`}>
        <span className={`dot ${overall}`} />
        {overall === "up"
          ? "All systems operational"
          : overall === "degraded"
            ? "Degraded performance on one or more services"
            : "Active incident — one or more services down"}
        {overall === "up" && summary.sloBreached > 0 && (
          <span className="banner-note">
            {summary.sloBreached} service{summary.sloBreached > 1 ? "s" : ""}{" "}
            over the 30-day SLO budget
          </span>
        )}
      </div>

      {data.probeDataAgeMinutes != null &&
        data.probeDataAgeMinutes > STALE_AFTER_MINUTES && (
          <div className="banner degraded stale">
            <span className="dot degraded" />
            Probe data is {fmtAge(data.probeDataAgeMinutes)} old — the
            scheduled prober may not be running, so states reflect the last
            available probes.
          </div>
        )}

      <div className="summary">
        <span className="pill">
          <b>{summary.total}</b> services
        </span>
        <span className="pill">
          <b style={{ color: "var(--up)" }}>{summary.up}</b> up
        </span>
        <span className="pill">
          <b style={{ color: "var(--degraded)" }}>{summary.degraded}</b> degraded
        </span>
        <span className="pill">
          <b style={{ color: "var(--down)" }}>{summary.down}</b> down
        </span>
        <span className="pill">
          <b style={{ color: "var(--down)" }}>{summary.firingServices}</b> firing
        </span>
        <span className="pill">
          <b style={{ color: "var(--degraded)" }}>{summary.sloBreached}</b> SLO
          breached
        </span>
      </div>

      {services.map((svc) => (
        <ServiceCard key={svc.config.name} svc={svc} />
      ))}

      <IncidentLog incidents={incidents} />

      {recentAlerts.length > 0 && (
        <section className="alerts-feed">
          <h2>Recent alert activity</h2>
          {recentAlerts.map((e, i) => (
            <div className="event" key={i}>
              <span className="ts">{fmtTime(e.ts)}</span>
              <span className={e.state === "firing" ? "firing" : "resolved"}>
                {e.state.toUpperCase()}
              </span>
              <span>
                <b>{e.service}</b> · {e.message}
              </span>
            </div>
          ))}
        </section>
      )}

      <footer className="site">
        <span>
          <span className="live-dot" />
          Live · updates every {POLL_MS / 1000}s · last {fmtTime(updatedAt)}
        </span>
        <span>
          <a href="/api/metrics">/api/metrics</a> ·{" "}
          <a href="/api/status">/api/status</a>
        </span>
      </footer>
    </>
  );
}

function ServiceCard({ svc }: { svc: ServiceCardModel }) {
  const { slo, alert, sparkline } = svc;
  const budgetPct = Math.round(slo.budgetRemainingRatio * 100);
  const budgetClass =
    slo.budgetRemainingRatio <= 0.1
      ? "bad"
      : slo.budgetRemainingRatio <= 0.4
        ? "warn"
        : "";

  const sloBreaches = [
    !slo.availabilityMet ? "availability" : null,
    !slo.latencyMet ? "latency" : null,
  ].filter(Boolean);

  // Sparkline expects oldest -> newest left to right.
  const bars = [...sparkline].reverse();

  return (
    <div className="card">
      <div className="card-head">
        <div className="svc-name">
          <span className={`dot ${svc.state}`} />
          {svc.config.name}
          <span className={`state-tag ${svc.state}`}>{svc.state}</span>
          <span
            className={`state-tag ${sloBreaches.length ? "degraded" : "up"}`}
            title={`SLO compliance over the rolling ${slo.windowDays}-day window — independent of current status`}
          >
            {sloBreaches.length
              ? `${slo.windowDays}d SLO: ${sloBreaches.join(" + ")} over budget`
              : `${slo.windowDays}d SLO met`}
          </span>
          <TlsTag svc={svc} />
        </div>
        <a className="svc-url" href={svc.config.url} target="_blank" rel="noreferrer">
          {svc.config.url}
        </a>
      </div>

      <UptimeBars uptime={svc.uptime} />

      <div className="sparkbar" title="Most recent probes (left = older)">
        {bars.length === 0 ? (
          <i className="none" />
        ) : (
          bars.map((p, i) => {
            const h = p.latency_ms != null ? clamp(p.latency_ms, slo.latencyTargetMs) : 100;
            return (
              <i
                key={i}
                className={p.ok ? "" : "down"}
                style={{ height: `${h}%` }}
                title={`${p.ts} · ${p.ok ? "ok" : "fail"} · ${
                  p.latency_ms != null ? Math.round(p.latency_ms) + "ms" : "no sample"
                }${p.status_code != null ? " · HTTP " + p.status_code : ""}`}
              />
            );
          })
        )}
      </div>

      <div className="metrics-row">
        <Metric
          label={`Availability (${slo.windowDays}d)`}
          value={pct(slo.availability)}
          bad={!slo.availabilityMet}
        />
        <Metric
          label={`Target`}
          value={pct(slo.availabilityTarget)}
        />
        <Metric
          label={`p${slo.latencyPercentile} latency`}
          value={slo.latencyP95Ms != null ? `${Math.round(slo.latencyP95Ms)} ms` : "—"}
          warn={!slo.latencyMet}
        />
        <Metric label="Latency SLO" value={`${slo.latencyTargetMs} ms`} />
        <Metric
          label="Last probe"
          value={
            svc.lastProbe
              ? `${svc.lastProbe.ok ? "ok" : "fail"}${
                  svc.lastProbe.latency_ms != null
                    ? " · " + Math.round(svc.lastProbe.latency_ms) + "ms"
                    : ""
                }`
              : "—"
          }
          bad={svc.lastProbe ? !svc.lastProbe.ok : false}
        />
        <Metric
          label="Probes (window)"
          value={`${slo.total.toLocaleString()}${
            slo.failures ? " · " + slo.failures + " fail" : ""
          }`}
        />
      </div>

      <div className="budget">
        <div className="metric">
          <span className="label">
            Error budget remaining · {budgetPct}%
          </span>
        </div>
        <div className="track">
          <div
            className={`fill ${budgetClass}`}
            style={{ width: `${Math.max(2, budgetPct)}%` }}
          />
        </div>
      </div>

      <div className="policies">
        {alert.evaluations.map((ev) => (
          <div key={ev.policy} className={`policy ${ev.firing ? "firing" : ""}`}>
            <span>
              <span className="sev">{ev.severity}</span> · {ev.policy} · {ev.label}
            </span>
            <span>
              burn {fmtBurn(ev.longBurnRate)} / {fmtBurn(ev.shortBurnRate)}
              {ev.firing ? " · FIRING" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TlsTag({ svc }: { svc: ServiceCardModel }) {
  const tls = svc.tls;
  if (!tls) return null;

  if (tls.error || tls.daysRemaining == null) {
    return (
      <span className="state-tag unknown" title={`TLS check failed: ${tls.error ?? "no certificate data"}`}>
        TLS ?
      </span>
    );
  }

  const cls = tls.daysRemaining > 30 ? "up" : tls.daysRemaining >= 14 ? "degraded" : "down";
  const expires = tls.notAfter ? new Date(tls.notAfter).toLocaleDateString() : "?";
  return (
    <span
      className={`state-tag ${cls}`}
      title={`Certificate expires ${expires}${tls.issuer ? ` · issued by ${tls.issuer}` : ""}`}
    >
      TLS {tls.daysRemaining}d
    </span>
  );
}

function UptimeBars({ uptime }: { uptime: ServiceCardModel["uptime"] }) {
  return (
    <div className="daybars-wrap">
      <div className="daybars">
        {uptime.days.map((d) => (
          <i key={d.date} className={dayClass(d)} title={dayTitle(d)} />
        ))}
      </div>
      <div className="daybars-caption">
        <span>{uptime.windowDays} days ago</span>
        <span>
          {uptime.availability == null
            ? "no data"
            : `${(uptime.availability * 100).toFixed(2)}% uptime (${uptime.windowDays}d)`}
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

function dayClass(d: DayCell): string {
  if (d.availability == null) return "empty";
  if (d.failures === 0) return "ok";
  return d.availability >= 0.97 ? "warn" : "bad";
}

function dayTitle(d: DayCell): string {
  if (d.availability == null) return `${d.date} · no data`;
  const parts = [
    d.date,
    `${(d.availability * 100).toFixed(2)}%`,
    `${d.failures}/${d.total} failed`,
  ];
  if (d.p95_ms != null) parts.push(`p95 ${Math.round(d.p95_ms)}ms`);
  return parts.join(" · ");
}

function IncidentLog({ incidents }: { incidents: Incident[] }) {
  return (
    <section className="incidents">
      <h2>Incidents (last 90 days)</h2>
      {incidents.length === 0 ? (
        <div className="incident none">
          No incidents — no service failed two or more probes in a row.
        </div>
      ) : (
        incidents.map((inc, i) => (
          <div className="incident" key={i}>
            <span className="ts">
              {fmtDateTime(inc.startedAt)}
              {inc.lastFailureAt !== inc.startedAt
                ? ` → ${fmtDateTime(inc.lastFailureAt)}`
                : ""}
            </span>
            <b>{inc.service}</b>
            {inc.ongoing ? (
              <span className="state-tag down">ongoing</span>
            ) : (
              <span className="dur">
                ≥{fmtDuration(inc.durationMinutes)} · {inc.failedProbes} failed
                probes
              </span>
            )}
            {inc.sampleError && <span className="err">{inc.sampleError}</span>}
          </div>
        ))
      )}
    </section>
  );
}

function fmtAge(minutes: number): string {
  if (minutes < 120) return `${minutes} minutes`;
  const h = Math.round(minutes / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Metric({
  label,
  value,
  bad,
  warn,
}: {
  label: string;
  value: string;
  bad?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className={`value ${bad ? "bad" : warn ? "warn" : ""}`}>{value}</div>
    </div>
  );
}

function clamp(latency: number, target: number): number {
  // Map latency to a 10..100% bar height relative to 2x the SLO target.
  const ratio = Math.min(1, latency / (target * 2));
  return Math.max(10, Math.round(ratio * 100));
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x >= 0.999 ? 3 : 2)}%`;
}

function fmtBurn(x: number): string {
  if (!isFinite(x)) return "∞";
  return `${x.toFixed(1)}x`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
