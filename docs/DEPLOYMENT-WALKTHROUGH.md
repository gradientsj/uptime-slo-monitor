# Deployment Walkthrough — how this monitor went live

A plain-English record of every step taken to deploy the Uptime & SLO Monitor
to **https://status.stanleyjacob.dev**, and *why* each step exists. Use this to
review what happened or to redo it from scratch.

## Mental model

Three independent pieces had to come together:

1. **Code** → lives on **GitHub** (`gradientsj/uptime-slo-monitor`).
2. **Hosting** → **Vercel** reads the code from GitHub, builds it, runs it at a URL.
3. **Database** → **Neon** (Postgres) stores every probe result.
4. **Domain** → **Porkbun** (registrar) points `status.stanleyjacob.dev` at Vercel.

Probing is driven by a **GitHub Action** every 5 minutes (Vercel's free cron only
runs once/day), which calls the app's `/api/probe` endpoint.

---

## Step 0 — verify the build locally (before any deploy)

```bash
npm install
npm test            # 17 unit tests (config, SLO math, alerts, auth, probe)
npm run typecheck   # tsc --noEmit
npm run build       # next build
```
We also ran it against a throwaway Postgres in Docker to confirm migrations,
seeding, a live probe, `/api/status`, and `/api/metrics` all worked end to end.

**Why:** never push code that fails CI; the GitHub Action runs these same checks.

---

## Step 1 — code onto GitHub

The project was already a git repo with commits. We created an empty repo on
github.com (named `uptime-slo-monitor`, no README/gitignore — the code already
had them), then:

```bash
git remote add origin https://github.com/gradientsj/uptime-slo-monitor.git
git push -u origin main
```

**Account note:** the GitHub account is `gradientsj`; the Vercel account is the
Google login `stanleyjacobai@gmail.com`. They're different identities — that's
fine. Vercel reads the repo via its **GitHub App**, which we installed on the
`gradientsj` account and granted access to this one repo.

**Why a browser popup appeared on first push:** a brand-new GitHub account has no
cached credentials, so Git Credential Manager opened a browser to authorize.

---

## Step 2 — import into Vercel (it goes live)

1. vercel.com → **Add New → Project**.
2. "Import Git Repository" → clicked **Add GitHub Account / Configure GitHub App**
   → installed the **Vercel** app on `gradientsj` → granted `uptime-slo-monitor`.
3. The repo appeared → **Import**.
4. Configure screen — **left everything default**: Framework = Next.js (auto),
   Root Directory `./`, Build/Output untouched, **no environment variables yet**.
5. **Deploy** → got `https://uptime-slo-monitor.vercel.app`.

At this point the page loaded but showed **"Could not load monitor data."** That
was expected — the app was live but had no database. (The app is written to
degrade gracefully instead of crashing when `DATABASE_URL` is missing.)

**Why deploy before adding the DB:** confidence + isolation. We confirmed the app
builds and serves first, then added data — so if something broke, we'd know which
half.

---

## Step 2.5 — a real bug we found and fixed

The first deploy's `/api/status` returned:
```
ENOENT: no such file or directory, open '/var/task/services.yaml'
```
On Vercel's serverless runtime, files read from disk at runtime aren't bundled
into the function unless Next.js "traces" them — and it doesn't trace a plain
`fs.readFileSync`. Fix, in `next.config.mjs`:

```js
experimental: {
  outputFileTracingIncludes: { "/**": ["./services.yaml"] },
}
```
Committed + pushed → Vercel auto-redeployed. (Every push to `main` triggers a
redeploy, because the repo is connected to the project.)

---

## Step 3 — add the database (Neon)

1. Vercel → project → **Storage** tab → **Create Database** → **Neon**.
2. Region near us, **Free** plan, created.
3. **Connected it to the `uptime-slo-monitor` project**, all 3 environments
   (Production / Preview / Development). Settings chosen:
   - **All environments:** so `DATABASE_URL` exists everywhere.
   - **"Create a database branch for deployment" → OFF:** we want one shared
     database, not a throwaway empty copy per preview deploy.
   - **Custom prefix → empty:** so the variable is named exactly `DATABASE_URL`
     (the app reads that name). A prefix would produce `PREFIX_DATABASE_URL`.

Connecting auto-injected `DATABASE_URL` (and friends) into the Vercel project. We
did **not** type any secret into Vercel by hand.

**Migrations + seed** (creating the tables and loading demo history). Run once,
locally, with the **pooled** connection string (host contains `-pooler`):

```bash
export DATABASE_URL="postgresql://...-pooler.../neondb?...sslmode=require"
npm run db:migrate     # creates tables (idempotent, tracked in schema_migrations)
npm run db:seed -- 2   # 2 days of synthetic history so the page isn't empty
```

> Gotcha we hit: the `!`-prefixed terminal in the session runs **bash**, so the
> PowerShell syntax `$env:DATABASE_URL=...` failed. In bash it's
> `export DATABASE_URL="..."`. Also added `prepare:false` to the migrate/seed
> scripts so they work against Neon's pooled (PgBouncer) endpoint.

After this, `/api/health` returned `{"status":"ok"}` and the page filled with
data.

---

## Step 4 — turn on live probing (CRON_SECRET + GitHub Action)

`/api/probe` is protected so the public can't trigger probing. It returned
`503 CRON_SECRET is required in production` until we set the secret.

1. **Vercel** → Settings → **Environment Variables** → added `CRON_SECRET`
   (a long random string), marked **Sensitive**, all environments.
2. **Redeployed** (env-var changes only apply to *new* deployments — we pushed an
   empty commit to trigger one).
3. **GitHub** → repo → Settings → **Secrets and variables → Actions** → added:
   - `PROBE_URL` = `https://uptime-slo-monitor.vercel.app/api/probe`
   - `CRON_SECRET` = the same string as in Vercel
4. Verified: a real probe of 5 endpoints returned
   `{"ok":true,"probed":5,...}`.

The workflow `.github/workflows/probe-cron.yml` now calls `/api/probe` every 5
minutes with `Authorization: Bearer $CRON_SECRET`.

---

## Step 5 — custom domain (Porkbun → Vercel)

1. **Vercel** → Settings → **Domains** → added `status.stanleyjacob.dev`. Vercel
   displayed the DNS record it wanted:
   `CNAME  status  →  f43ff3e6c1d921f3.vercel-dns-017.com` (its newer target;
   the older `cname.vercel-dns.com` also works).
2. **Porkbun** → Domain Management → `stanleyjacob.dev` → DNS → added:
   `CNAME  Host: status  →  cname.vercel-dns.com`
   (left Porkbun's default ALIAS on the apex and the `*` wildcard alone — a
   specific `status` record always wins over the wildcard).
3. DNS propagated in ~1 min; Vercel flipped to **Valid Configuration** and
   auto-issued the HTTPS certificate. `https://status.stanleyjacob.dev` → 200.

**Why a subdomain:** keeps the bare `stanleyjacob.dev` free for the personal
portfolio site; the monitor is "one window" of the domain.

---

## Final state

| Piece | Where |
| --- | --- |
| Status page | https://status.stanleyjacob.dev (and `*.vercel.app`) |
| Repo | github.com/gradientsj/uptime-slo-monitor |
| Database | Neon (via Vercel Storage), `DATABASE_URL` env var |
| Probing | GitHub Action `probe-cron`, every 5 min → `/api/probe` |
| Metrics | `/api/metrics` (Prometheus format) |

## Open follow-ups

- **Confirm the `probe-cron` Action runs green** (Actions tab → Run workflow).
- **Rotate the Neon password** — it was pasted in the setup chat, so it's
  considered compromised (low risk: public uptime data only). Reset in the Neon
  console; the Vercel integration usually re-syncs `DATABASE_URL`.
- **GKE deployment** (Terraform + Helm in `deploy/`) is built and validated but
  not deployed — it needs a GCP billing account. See `docs/DEPLOY.md` §B.
