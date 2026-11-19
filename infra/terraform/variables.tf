variable "project_id" {
  description = "Target GCP project ID (must already exist with billing enabled)."
  type        = string
}

variable "region" {
  description = "Single GCP region for initial production deployment (e.g., us-central1)."
  type        = string
}

variable "environment" {
  description = "Deployment environment identifier (e.g., prod, staging, dev)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase alphanumeric/hyphen characters."
  }
}

variable "identity_project_id" {
  description = "GCP project ID hosting Identity Platform (defaults to var.project_id when null)."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Consistent prefix for all managed GCP resources."
  type        = string
  default     = "hr-finance"
}

variable "github_repository" {
  description = "GitHub owner/repo allowed to authenticate via Workload Identity Federation."
  type        = string
  default     = "leesangyeon1/harnessrouter-hackathon"
}

variable "deploy_git_refs" {
  description = "Git refs permitted to assume the CI/CD deployer service account via OIDC."
  type        = list(string)
  default     = ["refs/heads/main", "refs/heads/dev"]
}

# --- Existing resource reuse / import switches ---

variable "create_artifact_registry" {
  description = "Set false to reuse an existing Artifact Registry Docker repository."
  type        = bool
  default     = true
}

variable "existing_artifact_registry_repo_id" {
  description = "Repository ID when create_artifact_registry = false."
  type        = string
  default     = ""
}

variable "create_cloud_sql_instance" {
  description = "Set false to connect to an existing Cloud SQL for PostgreSQL instance."
  type        = bool
  default     = true
}

variable "existing_cloud_sql_instance_name" {
  description = "Existing Cloud SQL instance name when create_cloud_sql_instance = false."
  type        = string
  default     = ""
}

variable "create_wif_pool" {
  description = "Set false if bootstrap_wif.sh already created github-actions-pool (or import it)."
  type        = bool
  default     = false
}

variable "deploy_web_service" {
  description = "Enable Next.js Cloud Run service once apps/web image has been built and pushed."
  type        = bool
  default     = false
}

# --- Container images ---

variable "api_image" {
  description = "Immutable Artifact Registry image URI (with tag or @sha256) for finance-api/worker/jobs."
  type        = string
}

variable "web_image" {
  description = "Immutable Artifact Registry image URI for finance-web (required when deploy_web_service = true)."
  type        = string
  default     = ""
}

# --- Domain, Auth & Public Next.js configuration ---

variable "cors_allowed_origins" {
  description = "Explicit HTTPS origins permitted to call the FastAPI service from browsers."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for origin in var.cors_allowed_origins : startswith(origin, "https://") && origin != "*"])
    error_message = "Every CORS allowed origin in cloud environments must start with https:// and must not be '*'."
  }
}

variable "next_public_api_base_url" {
  description = "Public HTTPS base URL of the FastAPI service exposed to the browser."
  type        = string
  default     = ""
}

variable "next_public_firebase_api_key" {
  description = "Public Identity Platform / Firebase Web API key (public identifier, not a backend secret)."
  type        = string
  default     = ""
}

variable "next_public_firebase_auth_domain" {
  description = "Identity Platform authDomain (e.g., <project>.firebaseapp.com or custom auth domain)."
  type        = string
  default     = ""
}

# --- Provider Sandbox & Paper guardrails ---

variable "plaid_host" {
  description = "Plaid API host. Locked to sandbox.plaid.com."
  type        = string
  default     = "sandbox.plaid.com"

  validation {
    condition     = var.plaid_host == "sandbox.plaid.com"
    error_message = "Only Plaid Sandbox (sandbox.plaid.com) is permitted."
  }
}

variable "alpaca_paper_base_url" {
  description = "Alpaca trading base URL. Locked to paper-api.alpaca.markets (live trading prohibited)."
  type        = string
  default     = "https://paper-api.alpaca.markets"

  validation {
    condition     = var.alpaca_paper_base_url == "https://paper-api.alpaca.markets"
    error_message = "Live trading is prohibited; alpaca_paper_base_url must be https://paper-api.alpaca.markets."
  }
}

# --- Cloud SQL sizing & HA ---

variable "db_tier" {
  description = "Cloud SQL machine tier (dedicated vCPU/RAM required for REGIONAL HA in prod)."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_availability_type" {
  description = "Override Cloud SQL availability_type (REGIONAL or ZONAL). Defaults to REGIONAL when environment == 'prod'."
  type        = string
  default     = null
}

variable "db_max_connections" {
  description = "PostgreSQL max_connections flag. Must exceed worst-case sum of service/job pools plus admin reserve."
  type        = number
  default     = 200
}

# --- Cloud Run Service Sizing & Concurrency ---

variable "web_cpu" {
  type    = string
  default = "1"
}

variable "web_memory" {
  type    = string
  default = "512Mi"
}

variable "web_concurrency" {
  type    = number
  default = 80
}

variable "web_min_instances" {
  type    = number
  default = 0
}

variable "web_max_instances" {
  type    = number
  default = 10
}

variable "api_cpu" {
  type    = string
  default = "1"
}

variable "api_memory" {
  type    = string
  default = "512Mi"
}

variable "api_concurrency" {
  type    = number
  default = 20
}

variable "api_min_instances" {
  type    = number
  default = 1
}

variable "api_max_instances" {
  type    = number
  default = 15
}

variable "api_db_pool_max" {
  type    = number
  default = 6
}

variable "worker_cpu" {
  type    = string
  default = "1"
}

variable "worker_memory" {
  type    = string
  default = "512Mi"
}

variable "worker_concurrency" {
  description = "Bounded concurrency on private HarnessRouter worker to respect external model quotas."
  type        = number
  default     = 4
}

variable "worker_min_instances" {
  type    = number
  default = 0
}

variable "worker_max_instances" {
  type    = number
  default = 5
}

variable "worker_db_pool_max" {
  type    = number
  default = 4
}

variable "worker_timeout_seconds" {
  description = "Max HTTP request timeout on private worker (up to 1800s for Cloud Tasks HTTP targets; longer tasks use agent-task Cloud Run Job)."
  type        = number
  default     = 900

  validation {
    condition     = var.worker_timeout_seconds >= 60 && var.worker_timeout_seconds <= 1800
    error_message = "Cloud Tasks HTTP target timeout must be between 60 and 1800 seconds."
  }
}

# --- Cloud Tasks rate, concurrency, retry, and backoff ---

variable "tasks_max_dispatches_per_second" {
  type    = number
  default = 5
}

variable "tasks_max_concurrent_dispatches" {
  type    = number
  default = 10
}

variable "tasks_max_attempts" {
  type    = number
  default = 5
}

variable "tasks_max_retry_duration" {
  type    = string
  default = "3600s"
}

variable "tasks_min_backoff" {
  type    = string
  default = "10s"
}

variable "tasks_max_backoff" {
  type    = string
  default = "300s"
}

variable "tasks_max_doublings" {
  type    = number
  default = 4
}

# --- Cloud Scheduler (market-ingest & paper-order) ---

variable "enable_scheduler_jobs" {
  description = "Enable Cloud Scheduler cron triggers once market-ingest/paper-order schedules and modules are confirmed."
  type        = bool
  default     = false
}

variable "scheduler_timezone" {
  description = "IANA timezone for trading-day schedules (e.g., America/New_York)."
  type        = string
  default     = ""
}

variable "schedule_market_ingest" {
  description = "Cron schedule for market-ingest job (required when enable_scheduler_jobs = true)."
  type        = string
  default     = ""
}

variable "schedule_paper_order" {
  description = "Cron schedule for paper-order job (required when enable_scheduler_jobs = true)."
  type        = string
  default     = ""
}

# --- Monitoring notification channels ---

variable "alert_notification_channels" {
  description = "Existing Cloud Monitoring notification channel IDs to attach to alert policies."
  type        = list(string)
  default     = []
}
