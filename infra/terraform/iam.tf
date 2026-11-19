# Dedicated least-privilege Service Accounts (account_id strictly <= 30 chars).

resource "google_service_account" "web" {
  account_id   = substr("hr-${var.environment}-web", 0, 28)
  display_name = "${local.prefix} Next.js Customer Web Service"
}

resource "google_service_account" "admin" {
  account_id   = substr("hr-${var.environment}-admin", 0, 28)
  display_name = "${local.prefix} Next.js Operations Admin Service"
}

resource "google_service_account" "api" {
  account_id   = substr("hr-${var.environment}-api", 0, 28)
  display_name = "${local.prefix} FastAPI Service"
}

resource "google_service_account" "worker" {
  account_id   = substr("hr-${var.environment}-worker", 0, 28)
  display_name = "${local.prefix} Private HarnessRouter Worker"
}

resource "google_service_account" "tasks_invoker" {
  account_id   = substr("hr-${var.environment}-tasks-inv", 0, 28)
  display_name = "${local.prefix} Cloud Tasks OIDC Invoker"
}

resource "google_service_account" "migrator" {
  account_id   = substr("hr-${var.environment}-migrator", 0, 28)
  display_name = "${local.prefix} DB Migration Job"
}

resource "google_service_account" "cycle_job" {
  account_id   = substr("hr-${var.environment}-cycle-job", 0, 28)
  display_name = "${local.prefix} Market Ingest Cycle Job"
}

resource "google_service_account" "executor_job" {
  account_id   = substr("hr-${var.environment}-exec-job", 0, 28)
  display_name = "${local.prefix} Paper Order Executor Job"
}

resource "google_service_account" "scheduler" {
  account_id   = substr("hr-${var.environment}-scheduler", 0, 28)
  display_name = "${local.prefix} Cloud Scheduler Job Trigger"
}

resource "google_service_account" "cicd" {
  account_id   = substr("hr-${var.environment}-cicd", 0, 28)
  display_name = "${local.prefix} GitHub Actions OIDC Deployer"
}

# --- Project-level roles: strictly minimal ---

locals {
  cloudsql_clients = {
    api          = google_service_account.api.email
    worker       = google_service_account.worker.email
    migrator     = google_service_account.migrator.email
    cycle_job    = google_service_account.cycle_job.email
    executor_job = google_service_account.executor_job.email
  }

  log_writers = merge(local.cloudsql_clients, {
    web   = google_service_account.web.email
    admin = google_service_account.admin.email
  })
}

resource "google_project_iam_member" "cloudsql_client" {
  for_each = local.cloudsql_clients

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "log_writer" {
  for_each = local.log_writers

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${each.value}"
}

# Only FastAPI service can enqueue tasks onto the HarnessRouter queue (scoped in cloud_tasks.tf),
# and sign OIDC token as tasks_invoker when creating Cloud Tasks HTTP requests.
resource "google_service_account_iam_member" "api_act_as_tasks_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# CI/CD deployer permissions (push images, deploy Cloud Run revisions/jobs, attach runtime SAs)
resource "google_project_iam_member" "cicd_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.cicd.email}"
}

resource "google_project_iam_member" "cicd_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.cicd.email}"
}

locals {
  runtime_service_accounts = {
    web          = google_service_account.web.name
    admin        = google_service_account.admin.name
    api          = google_service_account.api.name
    worker       = google_service_account.worker.name
    migrator     = google_service_account.migrator.name
    cycle_job    = google_service_account.cycle_job.name
    executor_job = google_service_account.executor_job.name
  }
}

resource "google_service_account_iam_member" "cicd_act_as_runtime" {
  for_each = local.runtime_service_accounts

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cicd.email}"
}

# --- Optional Terraform-managed Workload Identity Federation for GitHub Actions ---

resource "google_iam_workload_identity_pool" "github" {
  count = var.create_wif_pool ? 1 : 0

  workload_identity_pool_id = "${local.prefix}-gh-pool"
  display_name              = "GitHub Actions Pool (${var.environment})"
  description               = "OIDC federation for ${var.github_repository} without SA keys"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = var.create_wif_pool ? 1 : 0

  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  attribute_condition = format(
    "assertion.repository == '%s' && (%s)",
    var.github_repository,
    join(" || ", [for r in var.deploy_git_refs : format("assertion.ref == '%s'", r)])
  )

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "cicd_wif_binding" {
  count = var.create_wif_pool ? 1 : 0

  service_account_id = google_service_account.cicd.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}
