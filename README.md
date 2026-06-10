# Uptime & SLO Monitor

A self-hosted service that probes a set of live public and personal API
endpoints on a schedule, records latency and availability in Postgres, and
serves a **public status page** showing real-time and historical uptime.

It computes availability and latency **SLIs** over rolling windows, tracks
**error-budget burn** against **SLO targets** set per service in YAML, and fires
**multi-window, multi-burn-rate alerts** — a fast burn pages immediately while a
slow burn warns. It exposes **Prometheus metrics** with **Grafana dashboards**
per service, is packaged with **Docker**, deploys to **Vercel** (live status
page) and **GKE via Terraform + Helm**, and ships with a **k6 load test** that
verifies the probe path stays within its latency budget under concurrency.

> Live: **https://stanleyjacob.dev** → Projects → Uptime & SLO Monitor

---

## Architecture

```
                          ┌──────────────────────────────────────────┐
   GitHub Actions  ──5m──▶ │  /api/probe   (Vercel, Node runtime)      │
   (probe-cron)            │  probe all services → insert results      │
                           │  evaluate alert policies → log events     │
   Vercel Cron  ──daily──▶ │  prune old data                           │
                          └───────────────┬──────────────────────────┘
                                           │
   GKE worker  ──1m──▶  probe + /metrics + /healthz   │  writes
   (Helm)                                              ▼
                                            ┌────────────────────┐
                                            │   Postgres (Neon    │
                                            │   / Cloud SQL)      │
                                            └─────────┬──────────┘
                                                      │ reads
        ┌─────────────────────────────────────────────┴───────────────┐
        ▼                              ▼                                ▼
  Status page (Vercel)         /api/metrics (Prometheus)        Grafana dashboards
  real-time + history          availability / burn / latency    per-service SLOs
```

All SLO and alert math lives in `src/lib/` and is shared verbatim by the Vercel
API routes (`src/app/api/*`) and the standalone worker (`worker/index.ts`), so
results are identical regardless of where probing runs.

| Path | What |
| --- | --- |
| `src/lib/probe.ts` | Probe one endpoint (timeout, retries, latency, expected status) |
| `src/lib/sli.ts` | Availability + latency SLIs over rolling windows; history buckets |
| `src/lib/slo.ts` | Error budget, budget consumed/remaining, burn rate |
| `src/lib/state.ts` | Current-health state machine (decoupled from SLO compliance) |
| `src/lib/alerts.ts` | Multi-window multi-burn-rate policies + transition logging + webhook push |
| `src/lib/metrics.ts` | Prometheus text exposition |
| `services.yaml` | Per-service endpoints + SLO targets |

---

## Quick start — full stack, locally (Docker)

Brings up Postgres + migrations + probe worker + status page + Prometheus +
Grafana, end to end:

```bash
docker compose up --build
```

| Service | URL |
| --- | --- |
| Status page | http://localhost:3000 |
| Worker metrics | http://localhost:8080/metrics |
| Prometheus | http://localhost:9090 |
| Grafana (admin/admin) | http://localhost:3001 → *Uptime & SLO* folder |

Tear down (and wipe data): `docker compose down -v`.

## Quick start — app only (no Docker)

```bash
npm install
cp .env.example .env           # set DATABASE_URL (Neon/local Postgres)
npm run db:migrate             # create tables
npm run db:seed -- 2           # OPTIONAL: 2 days of synthetic history for the demo
npm run dev                    # http://localhost:3000
# In another shell, drive a probe tick:
curl -X POST localhost:3000/api/probe -H "Authorization: Bearer $CRON_SECRET"
```

Run the standalone worker instead of cron-pinging (probes every minute, serves
its own `/metrics` + `/healthz`):

```bash
npm run worker
```

---

## Configuration

Services and their SLOs are defined in [`services.yaml`](./services.yaml).
`defaults` apply to every service; any field can be overridden per service.

```yaml
defaults:
  availability_target: 0.99      # 1% error budget over the window
  latency_percentile: 95
  latency_target_ms: 800
  window_days: 30
  retries: 2                     # confirm failures before recording them
  retry_delay_ms: 250
services:
  - name: github-api
    url: https://api.github.com
    availability_target: 0.995
    latency_target_ms: 600
```

**Failure confirmation.** Probing from a single vantage point, a one-off
transient (DNS blip, runner egress reset, cold-start hiccup) is
indistinguishable from real downtime. A failed attempt is therefore retried
`retries` times before it counts as a failure; the recorded row keeps the
attempt count (`probe_results.attempts`).

**Sizing availability targets.** The error budget in *probes* is
`(1 − target) × samples-per-window`. At ~5–15 min effective cadence
(~3–9k samples per 30 days), a 99.9% target leaves a budget of only a few
probes — below the noise floor of any single-vantage prober. Don't set a
target the probe resolution can't measure; 99.0–99.5% is the honest range
for this setup.

Environment variables (see [`.env.example`](./.env.example)):

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (use the **pooled** URL on Vercel) |
| `CRON_SECRET` | Bearer token required to call `POST /api/probe` |
| `ALERT_WEBHOOK_URL` | Optional Slack/Discord webhook for alert transitions |
| `PROBE_SCHEDULE` | Worker cron (default `* * * * *`) |
| `RETENTION_DAYS` | History retention (default 45) |

---

## SLOs, error budget & alerting

**SLIs** — availability = successful probes ÷ total; latency = the configured
percentile (default p95) of successful-probe latency, both over the rolling
`window_days`.

**Current status vs SLO compliance** — the headline state on each card
(up / degraded / down) reflects *now*: recent probe outcomes and firing
burn-rate alerts (`src/lib/state.ts`). SLO compliance over the rolling window
is shown separately (the "30d SLO" tag and error-budget bar). A service can be
operational today while its monthly budget is already spent — the page shows
both rather than conflating them.

**Error budget** — `budget = 1 − availability_target`. The page shows the
fraction of that budget remaining.

**Burn rate** — `error_rate(window) ÷ budget`. A burn rate of 1 spends the
budget exactly over the SLO window; higher is too fast.

**Multi-window, multi-burn-rate alerts** (Google SRE Workbook). Each policy
pairs a long and short window and only fires when **both** exceed the threshold
— the long window confirms a real burn, the short window makes it fire and reset
quickly:

| Policy | Severity | Burn | Long / short |
| --- | --- | --- | --- |
| fast-burn | **page** | 14.4× | 1h / 5m |
| fast-burn-6h | **page** | 6× | 6h / 30m |
| slow-burn-1d | ticket | 3× | 1d / 2h |
| slow-burn-3d | ticket | 1× | 3d / 6h |

Firing/resolved transitions are written to `alert_events`, shown on the
status page, and — when `ALERT_WEBHOOK_URL` is set — pushed to a webhook. The
payload carries both `text` and `content`, so Slack incoming webhooks and
Discord webhooks work without an adapter.

---

## Uptime badges

`GET /api/badge/<service>` renders a shields-style SVG badge with availability
over the SLO window (green = SLO met, red = over budget), cacheable at the
edge. Embed it in a README:

```markdown
![uptime](https://status.stanleyjacob.dev/api/badge/github-api)
```

`?label=...` overrides the left-hand text.

---

## Prometheus metrics

`GET /api/metrics` (web) and `GET :8080/metrics` (worker) expose, per service:
`probe_up`, `probe_last_latency_milliseconds`, `slo_availability_ratio`,
`slo_latency_p95_milliseconds`, `slo_error_budget_remaining_ratio`,
`slo_burn_rate{window=…}`, and `alert_firing{policy,severity}`. Prometheus
scrape config is in [`prometheus/`](./prometheus); Grafana dashboards and
provisioning in [`grafana/`](./grafana).

---

## Load test

```bash
BASE_URL=http://localhost:3000 BUDGET_MS=800 VUS=50 npm run loadtest
```

Ramps concurrent virtual users against the probe/read path and **fails** if p95
latency exceeds `BUDGET_MS` or the error rate exceeds 1% — usable as a CI gate.

---

## Deploy

- **Vercel (live status page):** see [`docs/DEPLOY.md`](./docs/DEPLOY.md).
- **GKE (Terraform + Helm):** see [`docs/DEPLOY.md`](./docs/DEPLOY.md).
- **Runbook (failure modes & recovery):** see [`runbook.md`](./runbook.md).

CI (`.github/workflows/ci.yml`) typechecks + builds the app and runs
`terraform validate` + `helm lint` on every push.
