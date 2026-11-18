data "google_project" "current" {
  project_id = var.project_id
}

locals {
  prefix              = "${var.name_prefix}-${var.environment}"
  identity_project_id = coalesce(var.identity_project_id, var.project_id)
  db_ha_mode          = coalesce(var.db_availability_type, var.environment == "prod" ? "REGIONAL" : "ZONAL")

  labels = {
    app         = var.name_prefix
    environment = var.environment
    managed_by  = "terraform"
  }

  # Connection budget math:
  #   api peak     = api_max_instances * api_db_pool_max       (default: 15 * 6 = 90)
  #   worker peak  = worker_max_instances * worker_db_pool_max (default:  5 * 4 = 20)
  #   jobs reserve = migrate(1) + market-ingest(2) + paper-order(4) + agent-task(3) = 10
  #   admin/Cloud SQL maintenance reserve = 20
  estimated_peak_db_connections = (
    (var.api_max_instances * var.api_db_pool_max) +
    (var.worker_max_instances * var.worker_db_pool_max) +
    10 + 20
  )
}

check "db_connection_budget" {
  assert {
    condition     = local.estimated_peak_db_connections <= var.db_max_connections
    error_message = "Worst-case DB connections (${local.estimated_peak_db_connections}) exceed db_max_connections (${var.db_max_connections}). Reduce max_instances/pool_max or raise db_max_connections."
  }
}

check "scheduler_inputs_when_enabled" {
  assert {
    condition = (
      !var.enable_scheduler_jobs ||
      (var.scheduler_timezone != "" && var.schedule_market_ingest != "" && var.schedule_paper_order != "")
    )
    error_message = "When enable_scheduler_jobs = true, scheduler_timezone, schedule_market_ingest, and schedule_paper_order must all be explicitly provided."
  }
}

check "web_image_when_enabled" {
  assert {
    condition     = !var.deploy_web_service || var.web_image != ""
    error_message = "When deploy_web_service = true, web_image must be explicitly provided."
  }
}
