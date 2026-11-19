# Cloud Run v2 Jobs + Cloud Scheduler:
#   - db-migrate    : runs `python -m finance_api.migrate` using `db_url_migrator` (table owner)
#   - market-ingest : runs `python -m finance_api.jobs market-ingest` using `finance_cycle` role
#   - paper-order   : runs `python -m finance_api.jobs paper-order` using `finance_executor` role
#   - agent-task    : fallback job for HarnessRouter tasks whose runtime exceeds Cloud Tasks HTTP limits

# --- 1. Database Migration Job ---

resource "google_cloud_run_v2_job" "db_migrate" {
  name                = "${local.prefix}-db-migrate"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.migrator.email
      max_retries     = 0 # Never auto-retry failed DDL; abort deployment immediately
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.cloud_sql_connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["python", "-m", "finance_api.bootstrap_roles"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_migrator"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "BOOTSTRAP_API_DB_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_api"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "BOOTSTRAP_CYCLE_DB_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_cycle"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "BOOTSTRAP_EXECUTOR_DB_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_executor"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
  ]
}

# Allow CI/CD deployer to execute db-migrate job during release pipeline
resource "google_cloud_run_v2_job_iam_member" "cicd_execute_migrate" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.db_migrate.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.cicd.email}"
}

# --- 2. Market Ingest Cycle Job (`finance_cycle`) ---

resource "google_cloud_run_v2_job" "market_ingest" {
  name                = "${local.prefix}-market-ingest"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.cycle_job.email
      max_retries     = 2 # Safe: cycles(cycle_date) UNIQUE makes duplicate runs idempotent
      timeout         = "1800s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.cloud_sql_connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["python", "-m", "finance_api.jobs", "market-ingest"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "LOG_FORMAT"
          value = "json"
        }
        env {
          name  = "ALPACA_PAPER_BASE_URL"
          value = var.alpaca_paper_base_url
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_cycle"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "ALPACA_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["alpaca_data_api_key"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "ALPACA_SECRET_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["alpaca_data_secret_key"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
  ]
}

# --- 3. Paper Order Executor Job (`finance_executor`) ---

resource "google_cloud_run_v2_job" "paper_order" {
  name                = "${local.prefix}-paper-order"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.executor_job.email
      max_retries     = 1 # Safe: runs(portfolio_id, cycle_id) UNIQUE + orders.client_order_id intent-before-submit
      timeout         = "1800s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.cloud_sql_connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["python", "-m", "finance_api.jobs", "paper-order"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "LOG_FORMAT"
          value = "json"
        }
        env {
          name  = "ALPACA_PAPER_BASE_URL"
          value = var.alpaca_paper_base_url
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_executor"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SECRET_BOX_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["secret_box_key"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
  ]
}

# --- 4. Long-Running HarnessRouter Fallback Job (>1800s tasks) ---

resource "google_cloud_run_v2_job" "agent_task" {
  name                = "${local.prefix}-agent-task"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.worker.email
      max_retries     = 1
      timeout         = "3600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.cloud_sql_connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["python", "-m", "finance_api.jobs", "agent-task"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "LOG_FORMAT"
          value = "json"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["db_url_api"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "HARNESSROUTER_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["harnessrouter_api_key"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "TOKENROUTER_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["tokenrouter_api_key"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
  ]
}

# --- Cloud Scheduler -> Cloud Run Jobs IAM & Triggers ---

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_market_ingest" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.market_ingest.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_paper_order" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.paper_order.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "market_ingest" {
  count = var.enable_scheduler_jobs ? 1 : 0

  name             = "${local.prefix}-market-ingest-trigger"
  description      = "Triggers Cloud Run Job ${google_cloud_run_v2_job.market_ingest.name}"
  schedule         = var.schedule_market_ingest
  time_zone        = var.scheduler_timezone
  region           = var.region
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.market_ingest.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_invoke_market_ingest]
}

resource "google_cloud_scheduler_job" "paper_order" {
  count = var.enable_scheduler_jobs ? 1 : 0

  name             = "${local.prefix}-paper-order-trigger"
  description      = "Triggers Cloud Run Job ${google_cloud_run_v2_job.paper_order.name}"
  schedule         = var.schedule_paper_order
  time_zone        = var.scheduler_timezone
  region           = var.region
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 1
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.paper_order.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_invoke_paper_order]
}
