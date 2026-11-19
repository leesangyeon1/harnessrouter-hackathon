# Cloud Run v2 Services:
#   1. worker  (PRIVATE: Cloud Tasks OIDC invoker ONLY; no allUsers access)
#   2. api     (PUBLIC HTTPS: Identity Platform JWT on /v1/*, worker token on /worker/v1/*)
#   3. web     (PUBLIC HTTPS: unified Customer + Admin Next.js UI; zero backend secrets)

locals {
  worker_service_name      = "${local.prefix}-worker"
  deterministic_worker_url = "https://${local.worker_service_name}-${data.google_project.current.number}.${var.region}.run.app"
}

# --- 1. Private HarnessRouter Async Task Worker ---

resource "google_cloud_run_v2_service" "worker" {
  name                = local.worker_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # Required for Cloud Tasks HTTP push; IAM blocks unauthenticated/end-user traffic
  deletion_protection = var.environment == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.worker.email
    max_instance_request_concurrency = var.worker_concurrency
    timeout                          = "${var.worker_timeout_seconds}s"

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.cloud_sql_connection_name]
      }
    }

    containers {
      image   = var.api_image
      command = ["sh", "-c"]
      args = [
        "exec uvicorn finance_api.task_worker:worker_app_from_env --factory --host 0.0.0.0 --port \"$${PORT:-8080}\" --timeout-graceful-shutdown 25 --no-access-log"
      ]

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
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
        name  = "WORKER_SERVICE_URL"
        value = local.deterministic_worker_url
      }
      env {
        name  = "TASKS_INVOKER_SA_EMAIL"
        value = google_service_account.tasks_invoker.email
      }
      env {
        name  = "DB_POOL_MIN_SIZE"
        value = "1"
      }
      env {
        name  = "DB_POOL_MAX_SIZE"
        value = tostring(var.worker_db_pool_max)
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
        name = "SECRET_BOX_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["secret_box_key"].secret_id
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

      startup_probe {
        http_get {
          path = "/health/live"
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        timeout_seconds       = 4
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/health/live"
        }
        period_seconds    = 30
        timeout_seconds   = 4
        failure_threshold = 3
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
    google_secret_manager_secret_iam_member.vault_version_adder,
    google_secret_manager_secret_iam_member.vault_metadata_viewer,
  ]
}

# STRICT IAM: ONLY Cloud Tasks invoker SA may invoke the private worker service. Never allUsers.
resource "google_cloud_run_v2_service_iam_binding" "worker_invoker_strict" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  members  = ["serviceAccount:${google_service_account.tasks_invoker.email}"]
}

# --- 2. FastAPI Backend Service ---

resource "google_cloud_run_v2_service" "api" {
  name                = "${local.prefix}-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = var.api_concurrency
    timeout                          = "60s"

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.cloud_sql_connection_name]
      }
    }

    containers {
      image = var.api_image

      resources {
        limits = {
          cpu    = var.api_cpu
          memory = var.api_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
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
        name  = "IDENTITY_PROJECT_ID"
        value = local.identity_project_id
      }
      env {
        name  = "LOG_FORMAT"
        value = "json"
      }
      env {
        name  = "PLAID_HOST"
        value = var.plaid_host
      }
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = join(",", var.cors_allowed_origins)
      }
      env {
        name  = "DB_POOL_MIN_SIZE"
        value = "1"
      }
      env {
        name  = "DB_POOL_MAX_SIZE"
        value = tostring(var.api_db_pool_max)
      }
      env {
        name  = "CLOUD_TASKS_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CLOUD_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "CLOUD_TASKS_QUEUE"
        value = google_cloud_tasks_queue.harness_tasks.name
      }
      env {
        name  = "WORKER_SERVICE_URL"
        value = local.deterministic_worker_url
      }
      env {
        name  = "TASKS_INVOKER_SA_EMAIL"
        value = google_service_account.tasks_invoker.email
      }
      env {
        name  = "SECRET_PREFIX"
        value = local.prefix
      }
      env {
        name  = "SECRET_ADMIN_ALLOWED_EMAILS"
        value = join(",", var.secret_admin_allowed_emails)
      }
      env {
        name  = "PUBLIC_FIREBASE_API_KEY"
        value = var.next_public_firebase_api_key
      }
      env {
        name  = "PUBLIC_FIREBASE_AUTH_DOMAIN"
        value = var.next_public_firebase_auth_domain != "" ? var.next_public_firebase_auth_domain : "${local.identity_project_id}.firebaseapp.com"
      }
      env {
        name  = "GOOGLE_OAUTH_CLIENT_ID"
        value = var.google_oauth_client_id
      }
      env {
        name  = "PUBLIC_CUSTOMER_URL"
        value = var.public_customer_url
      }
      env {
        name  = "PUBLIC_ADMIN_URL"
        value = var.public_admin_url
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
        name = "SECRET_BOX_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["secret_box_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "PLAID_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["plaid_client_id"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "PLAID_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["plaid_secret"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health/live"
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        timeout_seconds       = 4
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/health/live"
        }
        period_seconds    = 30
        timeout_seconds   = 4
        failure_threshold = 3
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.accessor,
    google_secret_manager_secret_iam_member.vault_version_adder,
    google_secret_manager_secret_iam_member.vault_metadata_viewer,
  ]
}

# Public HTTPS entry for browsers (verified via Identity Platform JWT) and
# external owner CPU nodes (verified via worker_tokens SHA-256 bearer token).
resource "google_cloud_run_v2_service_iam_member" "api_public_https" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- 3. Next.js Customer UI Service (`apps/web`) ---

resource "google_cloud_run_v2_service" "web" {
  count = var.deploy_web_service ? 1 : 0

  name                = "${local.prefix}-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.web.email
    max_instance_request_concurrency = var.web_concurrency
    timeout                          = "60s"

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
    }

    containers {
      image = var.web_image

      resources {
        limits = {
          cpu    = var.web_cpu
          memory = var.web_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # ZERO Plaid, Alpaca, HarnessRouter, or DB secrets are mounted here.
      env {
        name  = "NODE_ENV"
        value = "production"
      }

      startup_probe {
        http_get {
          path = "/"
        }
        initial_delay_seconds = 1
        period_seconds        = 4
        timeout_seconds       = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/"
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "web_public_https" {
  count = var.deploy_web_service ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- 4. Next.js Operations Admin Service (`apps/admin`) ---

resource "google_cloud_run_v2_service" "admin" {
  count = var.deploy_admin_service ? 1 : 0

  name                = "${local.prefix}-admin"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.admin.email
    max_instance_request_concurrency = var.admin_concurrency
    timeout                          = "60s"

    scaling {
      min_instance_count = var.admin_min_instances
      max_instance_count = var.admin_max_instances
    }

    containers {
      image = var.admin_image

      resources {
        limits = {
          cpu    = var.admin_cpu
          memory = var.admin_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # Server-only runtime configuration per apps/web/HOSTING.md.
      # ZERO DB credentials, provider secrets, or SA private keys mounted.
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "INTERNAL_API_BASE_URL"
        value = google_cloud_run_v2_service.api.uri
      }
      env {
        name  = "ADMIN_APP_ORIGIN"
        value = coalesce(var.admin_app_origin != "" ? var.admin_app_origin : null, "https://${local.prefix}-admin-${data.google_project.current.number}.${var.region}.run.app")
      }

      startup_probe {
        http_get {
          path = "/"
        }
        initial_delay_seconds = 1
        period_seconds        = 4
        timeout_seconds       = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/"
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "admin_public_https" {
  count = var.deploy_admin_service ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.admin[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
