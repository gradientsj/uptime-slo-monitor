# Deploy

Two live targets: **Vercel** (public status page + probe endpoint, free) and
**GKE** (long-running prober + in-cluster Prometheus/Grafana, Terraform + Helm).
Both write to the **same Postgres**, so they form one system.

---

## A. Vercel (live status page)

### 1. Database (Neon)
Create a Postgres database (Neon free tier). Copy the **pooled** connection
string (host contains `-pooler`), e.g.
`postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require`.

### 2. Push to GitHub
```bash
git init && git add . && git commit -m "Uptime & SLO Monitor"
gh repo create uptime-slo-monitor --private --source=. --push
```

### 3. Link & configure the Vercel project
```bash
npm i -g vercel
vercel login
vercel link                       # create/link the project
# Add env vars (Production + Preview + Development):
vercel env add DATABASE_URL       # paste the pooled Neon URL
vercel env add CRON_SECRET        # a long random string
```

### 4. Migrate the database
```bash
DATABASE_URL="<pooled url>" npm run db:migrate
# optional demo data so the page isn't empty on first load:
DATABASE_URL="<pooled url>" npm run db:seed -- 2
```

### 5. Deploy
```bash
vercel --prod
```

### 6. Drive probing every 5 minutes (GitHub Actions)
Vercel Hobby crons run only once/day, so the `probe-cron` workflow drives the
real cadence. In the GitHub repo → **Settings → Secrets and variables →
Actions**, add:
- `PROBE_URL` = `https://<your-deployment>/api/probe`
- `CRON_SECRET` = the same value you set in Vercel

It runs every 5 min; trigger once manually under **Actions → probe-cron → Run
workflow** to verify (expect HTTP 200). *(On Vercel Pro, set
`vercel.json` cron to `* * * * *` and you can skip this.)*

### 7. Custom domain
`stanleyjacob.dev` is already on Vercel. Add a subdomain to this project:
```bash
vercel domains add status.stanleyjacob.dev
```
or in the dashboard: Project → Settings → Domains. Then link
`stanleyjacob.dev/projects` to it.

---

## B. GKE (Terraform + Helm)

> Real GCP cost (cluster + Cloud SQL). Requires `gcloud`, `terraform`, `helm`,
> `kubectl`, and a project with billing enabled.

### 1. Provision infra
```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # set project_id, your IP, etc.
gcloud auth application-default login
terraform init
terraform apply
# Outputs include the kubectl credentials command and the DATABASE_URL:
terraform output -raw database_url
eval "$(terraform output -raw get_credentials_command)"
```

### 2. Build & push images
```bash
# Example with Artifact Registry; substitute your registry.
REG=us-central1-docker.pkg.dev/$PROJECT/uptime
docker build -t $REG/web:latest -f Dockerfile .
docker build -t $REG/worker:latest -f Dockerfile.worker .
docker push $REG/web:latest && docker push $REG/worker:latest
```

### 3. Install the chart
```bash
helm upgrade --install uptime deploy/helm/uptime-monitor \
  --set image.worker.repository=$REG/worker --set image.worker.tag=latest \
  --set image.web.repository=$REG/web       --set image.web.tag=latest \
  --set database.url="$(terraform -chdir=deploy/terraform output -raw database_url)" \
  --set web.enabled=true \
  --set serviceMonitor.enabled=true            # if kube-prometheus-stack is installed
```
The pre-install Job runs migrations. The worker probes on its schedule and
exposes `/metrics`; the `ServiceMonitor` wires it into Prometheus.

### 4. Observability
Install kube-prometheus-stack (Prometheus + Grafana) if not present:
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kps prometheus-community/kube-prometheus-stack
```
Import `grafana/dashboards/slo-overview.json` (or point Grafana Cloud at the
in-cluster Prometheus).

### 5. Teardown
```bash
helm uninstall uptime
cd deploy/terraform && terraform destroy
```

---

## Validate before deploying

```bash
npm run typecheck && npm run build
cd deploy/terraform && terraform init -backend=false && terraform validate
helm lint deploy/helm/uptime-monitor
```
