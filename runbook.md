# Runbook — Uptime & SLO Monitor

Operational guide for common failure modes and recovery. Audience: whoever is
on call for this service.

## At a glance

| Symptom | Likely cause | Jump to |
| --- | --- | --- |
| Status page shows "Could not load monitor data" | DB unreachable / not migrated | [DB down](#1-database-unreachable) |
| All services show as `down` simultaneously | Prober not running, or network egress blocked | [No probes](#2-no-recent-probes) |
| One service `down`, target is actually up | Endpoint/SLO misconfig, or expected status mismatch | [False positive](#3-false-positive-for-one-service) |
| `degraded`/SLO breached, but every recent probe is green | Error budget spent by past prober noise; target too tight for the cadence | [Budget noise](#3a-slo-breached-but-the-endpoint-looks-healthy) |
| Page/ticket alert fired | Real burn, or alert tuning | [Alert firing](#4-alert-firing) |
| `/api/metrics` slow or 5xx | DB slow / overloaded; load beyond budget | [Slow metrics](#5-slow-or-failing-metrics) |
| Grafana panels empty | Prometheus not scraping / wrong target | [No metrics](#6-grafana-empty) |

---

## 1. Database unreachable

**Detect:** status page banner "Could not load monitor data"; `GET /api/health`
returns 503; worker `/healthz` 503; logs show `DATABASE_URL is not set` or
connection errors.

**Diagnose & recover:**
1. Confirm `DATABASE_URL` is set wherever it runs (Vercel env, Helm secret,
   `.env`). On Vercel use the **pooled** connection string.
2. Check the provider is up (Neon/Cloud SQL console). For Cloud SQL, confirm the
   pod/IP is in `authorized_networks` or the Auth Proxy is running.
3. If the schema is missing, run migrations:
   ```bash
   DATABASE_URL=... npm run db:migrate
   ```
   On GKE this runs automatically as a Helm `pre-upgrade` Job; re-run with
   `helm upgrade`.
4. Connection-pool exhaustion under load: lower `PG_POOL_MAX` and ensure you are
   using a pooled endpoint (`prepare:false` is already set for PgBouncer/Neon).

---

## 2. No recent probes

**Detect:** every service `unknown`/`down`; `probe_results` has no rows in the
last few minutes; on the page "last probe" is stale.

**Diagnose & recover:**
- **Vercel deployment:** the probe tick is driven by the `probe-cron` GitHub
  Action (every 5 min). Check **Actions → probe-cron** for failures. Common
  causes: `PROBE_URL`/`CRON_SECRET` repo secrets wrong → the curl gets 401.
  Trigger manually with **Run workflow**, or:
  ```bash
  curl -X POST "$PROBE_URL" -H "Authorization: Bearer $CRON_SECRET"
  ```
- **GKE worker:** `kubectl get pods -l app.kubernetes.io/component=worker`;
  check `kubectl logs`. Look for `tick error:`. Restart: `kubectl rollout
  restart deploy/<release>-uptime-monitor-worker`.
- **Egress blocked:** if every probe times out but the DB is fine, the
  environment can't reach the public internet. Verify NAT/egress and that the
  target URLs resolve from inside the pod (`kubectl exec ... -- wget -qO- URL`).

---

## 3. False positive for one service

**Detect:** one service shows `down`/`degraded` but is healthy when you curl it.

**Diagnose & recover:**
1. Look at the probe error on the card / in `probe_results.error`.
2. **Wrong expected status:** e.g. the endpoint returns 301/302 and we treat
   only `200,204` as success (we use `redirect: "manual"`). Add the status to
   `expect_status` or point at a non-redirecting URL in `services.yaml`.
3. **Timeout too tight:** raise `timeout_ms` for slow upstreams.
4. **Latency SLO too aggressive:** if it's only `degraded` on latency, retune
   `latency_target_ms`.
5. Redeploy (Vercel) or `helm upgrade` (GKE) / restart the worker to reload
   `services.yaml`.

---

## 3a. SLO breached, but the endpoint looks healthy

**Detect:** the card's current state is `up` and recent probes are green, but
the "30d SLO" tag shows a breach / the error budget bar is empty.

This is usually *prober noise spending the budget*, not real downtime. From a
single vantage point, a transient (Actions runner egress reset, DNS blip,
cold-start fetch hiccup) records as a failed probe — and at a sparse cadence a
handful of those can spend an entire month's budget.

**Diagnose & recover:**
1. Check `probe_results` for the failing rows: spread-out single failures with
   varied errors (`timeout`, `fetch failed (ECONNRESET)`) across *multiple
   services* at similar times = prober-side noise. Sustained same-service
   failures = real incident.
2. Check `probe_results.attempts` on failures: rows recorded with the full
   retry count mean the endpoint really failed `retries + 1` consecutive
   fetches; if old rows predate retries (attempts = 1), they may be one-off
   blips that today would have been absorbed.
3. **Target too tight for the cadence:** budget in probes =
   `(1 − target) × samples/window`. If that is fewer than ~10 probes, the
   target is below the prober's noise floor — lower it in `services.yaml`
   (see the header comment there).
4. The breach clears on its own as the rolling window moves past the noisy
   period. Truncating `probe_results` resets it immediately but loses history.

Note the page intentionally separates the two signals: current state (recent
probes + firing alerts) vs SLO compliance (rolling window). A service that is
fine *now* with a spent budget shows `up` + "SLO over budget", not `degraded`.

---

## 4. Alert firing

A multi-window multi-burn-rate alert (`alert_events.state = firing`) means both
the long and short windows exceeded the burn threshold.

1. **Triage severity:** `page` (fast-burn) = budget burning fast, act now;
   `ticket` (slow-burn) = investigate within the day.
2. Open the service card / Grafana: is the upstream actually erroring, or is it
   a probe-side issue (see §2/§3)?
3. If the upstream is genuinely degraded and it's a third-party dependency,
   record it; the alert auto-resolves (and logs a `resolved` event) once the
   short window clears.
4. **Alert is noisy / flapping:** tune thresholds, windows, or `minLongSamples`
   in `src/lib/alerts.ts`. With a 5-minute probe interval the 5-minute short
   window only has ~1 sample — increase probe frequency (worker `PROBE_SCHEDULE`)
   for crisper fast-burn detection.

---

## 5. Slow or failing metrics

**Detect:** `/api/metrics` p95 over budget (k6 load test fails), or 5xx.

**Diagnose & recover:**
- `/api/metrics` runs several aggregate queries per service at scrape time.
  Under heavy scrape concurrency this hits the DB hard. Mitigations: raise the
  Prometheus `scrape_interval`, ensure the indexes from `0001_init.sql` exist
  (`idx_probe_results_service_ts`), and keep retention bounded (`RETENTION_DAYS`).
- Confirm the prune job is running (worker logs `pruned N old probe rows`). A
  bloated `probe_results` slows every window query.
- Run the load test to confirm the budget after changes:
  `BASE_URL=... BUDGET_MS=800 npm run loadtest`.

---

## 6. Grafana empty

1. Prometheus **Status → Targets**: are `uptime-worker` / `uptime-web` UP? If
   DOWN, fix the target address (`prometheus/prometheus.yml`) or pod networking.
2. In GKE, confirm the `ServiceMonitor` is enabled and its `labels` match your
   kube-prometheus-stack release selector.
3. Datasource: Grafana → Connections → Prometheus should point at
   `http://prometheus:9090` (docker-compose) or your in-cluster Prometheus.

---

## Routine operations

- **Add/change a monitored service:** edit `services.yaml` (or the Helm
  `servicesYaml` value) → redeploy / `helm upgrade`.
- **Change an SLO target:** same file; budgets recompute on the next read.
- **Reset all data:** `docker compose down -v` locally, or truncate
  `probe_results`/`alert_events`/`alert_state`.
- **Rotate `CRON_SECRET`:** update the Vercel env var **and** the GitHub
  `CRON_SECRET` secret together, then redeploy.
