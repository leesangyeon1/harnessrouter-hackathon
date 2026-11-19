# Cloud Run & Cloud SQL Production Deployment Guide

This directory and `infra/terraform/` define the Google Cloud deployment architecture for the Finance Platform MVP, preserving all existing application domain contracts (`evaluation cycle` / `cycle_id` vs portfolio `runs`, forced PostgreSQL RLS, Identity Platform user auth, outbound CPU-node HTTPS polling, Plaid Sandbox lock, and Alpaca paper-trading lock).

---

## 1. Architecture Topology

```text
Browser (Customer UI + Admin Ops UI)
  |-- HTTPS --> Cloud Run Service: hr-finance-<env>-web (Next.js standalone, public, NO backend secrets)
  |-- HTTPS + Identity Platform JWT --> Cloud Run Service: hr-finance-<env>-api (FastAPI)
                                          |-- /v1/*          : Identity Platform JWT + per-request DB role check
                                          |-- /v1/admin/*    : require_admin (PostgreSQL user_roles == 'admin')
                                          |-- /worker/v1/*   : SHA-256 worker_tokens auth ONLY (outbound CPU nodes)
                                          |-- /health/*      : Liveness & DB/role readiness probes
                                          |-- Enqueue OIDC --> Cloud Tasks Queue (hr-finance-<env>-harness-tasks)
                                                                 |-- HTTPS + OIDC (sa-tasks-invoker ONLY)
                                                                 v
                                                       Cloud Run Service: hr-finance-<env>-worker (PRIVATE)
                                                         `uvicorn finance_api.task_worker:worker_app_from_env`

Owner External CPU Nodes (`quant-worker`)
  |-- Outbound HTTPS polling ONLY (`WORKER_API_URL` + `WORKER_TOKEN`, no redirects) --> /worker/v1/*

Cloud Scheduler (OAuth `sa-scheduler`)
  |-- Trigger --> Cloud Run Job: hr-finance-<env>-market-ingest (`finance_cycle` DB role, Alpaca market data)
  |-- Trigger --> Cloud Run Job: hr-finance-<env>-paper-order   (`finance_executor` DB role, Alpaca paper API)

CI/CD (GitHub Actions -> OIDC Workload Identity Federation -> `sa-cicd`)
  |-- Step 1: `make gate` + Terraform validate + image secret scan
  |-- Step 2: Push immutable `:SHA` images to Artifact Registry
  |-- Step 3: Execute Cloud Run Job `hr-finance-<env>-db-migrate` (`finance_migrator` owner role; aborts on error)
  |-- Step 4: Roll out Cloud Run Jobs & Services + readiness/auth smoke checks + automatic revision rollback
```

---

## 2. Single-Region HA vs. Full Region Disaster Recovery (DR)

Initial production is deployed in **one primary GCP region** (`var.region`):

| Failure Scope | Mechanism Configured Here | Expected Behavior (RPO / RTO) |
| --- | --- | --- |
| **Container / Instance crash** | Cloud Run multi-zone regional scheduling + `/health/live` & `/health/ready` probes | Automatic instance replacement within seconds; zero manual intervention. |
| **Single-Zone outage within `var.region`** | Cloud SQL `availability_type = "REGIONAL"` (synchronous standby in a secondary zone) + regional Cloud Run / Artifact Registry / Secret Manager / Cloud Tasks | Automatic zonal failover. **RPO = 0** (synchronous disk replication); **RTO ≈ 60–120s** while Cloud SQL promotes standby and `psycopg_pool` reconnects. |
| **Accidental data corruption / bad query** | Automated daily backups (14 retained) + **7-day Point-in-Time Recovery (PITR)** WAL archiving | Clone/restore Cloud SQL instance to exact second prior to incident (see Section 6). |
| **Entire-Region outage (`var.region` down)** | *Not covered by single-region `REGIONAL` HA alone.* Requires cross-region DR procedure: enable cross-region backup location (or cross-region read replica), re-run `terraform apply` targeting `<dr-region>`, promote replica / restore backup, and update DNS/load-balancer origin. | **RPO**: ~minutes (WAL shipping / cross-region backup); **RTO**: ~30–60 minutes via Terraform redeploy into DR region. |

---

## 3. Service Sizing, DB Connection Budget & External API Quotas

Cloud SQL `max_connections` defaults to **`200`** (checked at plan time by `check "db_connection_budget"` in `infra/terraform/main.tf`):

| Component | CPU / Memory | Concurrency | Min / Max Instances | Max DB Pool / Instance | Peak DB Connections | Quota / Isolation Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| `web` (Next.js) | `1 vCPU` / `512Mi` | `80` | `0` / `10` | `0` | `0` | Stateless UI; talks to `api` over HTTPS only. |
| `api` (FastAPI) | `1 vCPU` / `512Mi` | `20` | `1` / `15` | `6` | `90` | Sync `psycopg_pool` with `reset_tenant_context` on every return. |
| `worker` (HarnessRouter) | `1 vCPU` / `512Mi` | `4` | `0` / `5` | `4` | `20` | Caps concurrent HarnessRouter calls at `20` (and Cloud Tasks queue at `10` concurrent / `5/s`). If a task requires `>1800s`, route to `agent-task` Cloud Run Job (`3600s+`). |
| `db-migrate` Job | `1 vCPU` / `512Mi` | `1` task | `max_retries = 0` | `1` | `1` | Runs once before service rollout; owns schema (`CREATEROLE`). |
| `market-ingest` Job | `1 vCPU` / `1Gi` | `1` task | `max_retries = 2` | `2` | `2` | Single-task execution stays well under Alpaca market-data 200 req/min rate limit. |
| `paper-order` Job | `1 vCPU` / `512Mi` | `1` task | `max_retries = 1` | `4` | `4` | Single-task execution stays under Alpaca paper-trading 200 req/min limit; idempotent via `runs(portfolio_id, cycle_id)` & `orders.client_order_id`. |
| Admin / Maintenance reserve | — | — | — | — | `20` | Reserved for Cloud SQL internals, `psql` ops, and migrations. |
| **Total Peak** | — | — | — | — | **`137 <= 200`** | Verified automatically by Terraform `check`. |

---

## 4. Environment Variables & Secret Manager Inventory

### Secret Manager Secrets (Populated out-of-band; never in Git or Terraform state)

| Secret ID (`hr-finance-<env>-*`) | Format / Example | Mounted By Service Account(s) |
| --- | --- | --- |
| `db-url-migrator` | `postgresql://finance_migrator:<pw>@/finance?host=/cloudsql/<conn>` | `sa-migrator` ONLY |
| `db-url-api` | `postgresql://finance_api_app:<pw>@/finance?host=/cloudsql/<conn>` | `sa-api`, `sa-worker` |
| `db-url-cycle` | `postgresql://finance_cycle_app:<pw>@/finance?host=/cloudsql/<conn>` | `sa-cycle-job` ONLY |
| `db-url-executor` | `postgresql://finance_executor_app:<pw>@/finance?host=/cloudsql/<conn>` | `sa-exec-job` ONLY |
| `secret-box-key` | 32-byte URL-safe base64 Fernet key | `sa-api`, `sa-exec-job`, `sa-worker` |
| `plaid-client-id` | Plaid client ID | `sa-api` ONLY |
| `plaid-secret` | Plaid **Sandbox** secret | `sa-api` ONLY |
| `alpaca-data-api-key` | Alpaca market data key ID | `sa-cycle-job` ONLY |
| `alpaca-data-secret-key` | Alpaca market data secret key | `sa-cycle-job` ONLY |
| `harnessrouter-api-key` | HarnessRouter API key | `sa-worker` ONLY |

### Next.js Variable Separation
- **Public Browser (`NEXT_PUBLIC_*`)**: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_IDENTITY_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`.
- **Server-Only Runtime (`web` service)**: `INTERNAL_API_BASE_URL`, `NODE_ENV=production`.
- **Prohibited on `web`**: Plaid, Alpaca, HarnessRouter, Fernet, worker tokens, and DB URLs (enforced by `deploy/scripts/verify_bundle_secrets.sh` during `docker build`).

---

## 5. Initial Bootstrap & Subsequent Deployment Commands

```bash
# 1. Authenticate operator CLI (no keys in files/chat)
gcloud auth login
gcloud auth application-default login

# 2. Bootstrap APIs, Terraform GCS state bucket, and GitHub OIDC Workload Identity Federation
export GCP_PROJECT_ID="<YOUR_PROJECT_ID>"
export GCP_REGION="<YOUR_REGION>"
export TF_STATE_BUCKET="<YOUR_UNIQUE_TFSTATE_BUCKET>"
./deploy/scripts/bootstrap_wif.sh

# 3. Initialize & plan Terraform
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with confirmed project_id, region, environment, domains, schedules
terraform init -backend-config="bucket=${TF_STATE_BUCKET}" -backend-config="prefix=hr-finance/prod"
terraform fmt -check
terraform validate
terraform plan -out=tfplan
terraform apply tfplan

# 4. Populate Secret Manager versions from stdin (never in shell history)
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode(), end='')" \
  | gcloud secrets versions add "hr-finance-prod-secret-box-key" --data-file=- --project="${GCP_PROJECT_ID}"

# 5. Bootstrap PostgreSQL roles & run initial migration
# Run Step A of deploy/sql/bootstrap_db_users.sql via Cloud SQL Studio or Auth Proxy, then:
gcloud run jobs execute hr-finance-prod-db-migrate --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}" --wait
# Run Step B of deploy/sql/bootstrap_db_users.sql to bind finance_api_app -> finance_api, etc.
```

Subsequent releases run automatically via `.github/workflows/deploy.yml` on push to `main` (or `workflow_dispatch`) using GitHub OIDC.

---

## 6. DB Migration, Service Rollback & Backup Restore Runbook

### A. Database Migration Rules
- All SQL migrations in `apps/api/src/finance_api/migrations/` run in a single transaction via `python -m finance_api.migrate` (`max_retries = 0`).
- **Additive/backward-compatible migrations only** while previous Cloud Run revision is still serving traffic; destructive DDL (`DROP`, `TRUNCATE`) is prohibited.
- If `db-migrate` exits non-zero in `.github/workflows/deploy.yml`, the transaction rolls back cleanly in PostgreSQL and the workflow **stops immediately** before updating any Cloud Run service.

### B. Cloud Run Revision Rollback
```bash
# List recent revisions
gcloud run revisions list --service=hr-finance-prod-api --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}"

# Immediate traffic rollback to last known-good revision (or run GitHub Actions deploy.yml with action=rollback)
gcloud run services update-traffic hr-finance-prod-api \
  --to-revisions="<PREVIOUS_REVISION_NAME>=100" \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT_ID}"
```

### C. Cloud SQL Point-in-Time Recovery (PITR) & Backup Restore
> Never overwrite the live production instance in place; clone to a recovery instance first to inspect data safely.

```bash
# Point-in-time clone to an exact RFC3339 UTC timestamp prior to incident
gcloud sql instances clone hr-finance-prod-pg16 hr-finance-prod-pg16-recovery \
  --point-in-time="2026-11-18T22:00:00.000Z" \
  --project="${GCP_PROJECT_ID}"

# Or restore from a specific retained automated backup ID onto a recovery instance
gcloud sql backups list --instance=hr-finance-prod-pg16 --project="${GCP_PROJECT_ID}"
gcloud sql backups restore <BACKUP_ID> \
  --restore-instance=hr-finance-prod-pg16-recovery \
  --backup-instance=hr-finance-prod-pg16 \
  --project="${GCP_PROJECT_ID}"
```

---

## 7. Cloud Logging Queries for Operations & Tracing

1. **End-to-end trace from API -> Cloud Tasks worker / Job (`request_id`, `task_id`, `cycle_id`)**:
   ```text
   resource.type=("cloud_run_revision" OR "cloud_run_job")
   (jsonPayload.request_id="<ID>" OR jsonPayload.task_id="<TASK_ID>" OR jsonPayload.cycle_id="<CYCLE_UUID>")
   ```
2. **API / Worker 5xx errors & exceptions**:
   ```text
   resource.type="cloud_run_revision"
   resource.labels.service_name=~"^hr-finance-.*-(api|worker)$"
   (severity>=ERROR OR httpRequest.status>=500 OR jsonPayload.http_status>=500)
   ```
3. **Scheduled / Migration Cloud Run Job failures**:
   ```text
   resource.type="cloud_run_job"
   resource.labels.job_name=~"^hr-finance-.*"
   severity>=ERROR
   ```
4. **DB Readiness / Connection Pool saturation issues**:
   ```text
   (resource.type="cloud_run_revision" AND jsonPayload.message=~"Readiness database check failed|PoolTimeout")
   OR (resource.type="cloudsql_database" AND severity>=WARNING)
   ```
