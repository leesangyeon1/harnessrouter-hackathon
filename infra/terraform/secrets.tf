# Secret Manager containers ONLY (secret payloads are populated out-of-band via
# `gcloud secrets versions add ... --data-file=-` so plaintext never enters Terraform state or Git).
# Note: Next.js (`web`) receives ZERO backend secrets.

locals {
  secret_specs = {
    db_url_migrator = {
      id        = "${local.prefix}-db-url-migrator"
      accessors = [google_service_account.migrator.email]
    }
    db_url_api = {
      id = "${local.prefix}-db-url-api"
      accessors = [
        google_service_account.api.email,
        google_service_account.worker.email,
      ]
    }
    db_url_cycle = {
      id        = "${local.prefix}-db-url-cycle"
      accessors = [google_service_account.cycle_job.email]
    }
    db_url_executor = {
      id        = "${local.prefix}-db-url-executor"
      accessors = [google_service_account.executor_job.email]
    }
    secret_box_key = {
      id = "${local.prefix}-secret-box-key"
      accessors = [
        google_service_account.api.email,
        google_service_account.executor_job.email,
      ]
    }
    plaid_client_id = {
      id        = "${local.prefix}-plaid-client-id"
      accessors = [google_service_account.api.email]
    }
    plaid_secret = {
      id        = "${local.prefix}-plaid-secret"
      accessors = [google_service_account.api.email]
    }
    alpaca_data_api_key = {
      id        = "${local.prefix}-alpaca-data-api-key"
      accessors = [google_service_account.cycle_job.email]
    }
    alpaca_data_secret_key = {
      id        = "${local.prefix}-alpaca-data-secret-key"
      accessors = [google_service_account.cycle_job.email]
    }
    harnessrouter_api_key = {
      id        = "${local.prefix}-harnessrouter-api-key"
      accessors = [google_service_account.worker.email]
    }
  }

  secret_iam_bindings = merge([
    for key, spec in local.secret_specs : {
      for sa_email in spec.accessors :
      "${key}__${sa_email}" => {
        secret_key = key
        sa_email   = sa_email
      }
    }
  ]...)
}

resource "google_secret_manager_secret" "managed" {
  for_each = local.secret_specs

  secret_id = each.value.id
  labels    = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = local.secret_iam_bindings

  secret_id = google_secret_manager_secret.managed[each.value.secret_key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa_email}"
}
