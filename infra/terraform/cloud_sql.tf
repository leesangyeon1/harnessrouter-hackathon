# Cloud SQL for PostgreSQL 16
# Production enforces:
#   - REGIONAL High Availability (synchronous standby in a secondary zone of var.region)
#   - Automated daily backups + 7-day Point-in-Time Recovery (PITR) WAL retention
#   - Deletion protection enabled
#   - Encrypted connections required
#   - Separate DB users for migration vs runtime (finance_api, finance_cycle, finance_executor)

resource "google_sql_database_instance" "postgres" {
  count = var.create_cloud_sql_instance ? 1 : 0

  name                = "${local.prefix}-pg16"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.environment == "prod"

  settings {
    tier              = var.db_tier
    availability_type = local.db_ha_mode
    edition           = "ENTERPRISE"
    disk_type         = "PD_SSD"
    disk_size         = 20
    disk_autoresize   = true
    user_labels       = local.labels

    backup_configuration {
      enabled                        = true
      start_time                     = "07:00" # UTC (outside US regular market hours)
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    # Log DDL and connection errors only; never set log_statement = 'all' so
    # financial rows, query parameters, and tokens are excluded from PostgreSQL logs.
    database_flags {
      name  = "max_connections"
      value = tostring(var.db_max_connections)
    }

    database_flags {
      name  = "log_statement"
      value = "ddl"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "2000"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      record_client_address   = false
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 8 # UTC
      update_track = "stable"
    }
  }

  depends_on = [google_project_service.required]
}

data "google_sql_database_instance" "existing" {
  count = var.create_cloud_sql_instance ? 0 : 1
  name  = var.existing_cloud_sql_instance_name
}

locals {
  cloud_sql_instance_name = (
    var.create_cloud_sql_instance
    ? google_sql_database_instance.postgres[0].name
    : data.google_sql_database_instance.existing[0].name
  )
  cloud_sql_connection_name = (
    var.create_cloud_sql_instance
    ? google_sql_database_instance.postgres[0].connection_name
    : data.google_sql_database_instance.existing[0].connection_name
  )
}

resource "google_sql_database" "finance" {
  count = var.create_cloud_sql_instance ? 1 : 0

  name     = "finance"
  instance = local.cloud_sql_instance_name
}
