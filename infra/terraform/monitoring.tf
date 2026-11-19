# Cloud Logging Metrics & Cloud Monitoring Alert Policies:
#   1. FastAPI / Worker 5xx error spike
#   2. Cloud Run Job execution failure (db-migrate, market-ingest, paper-order, agent-task)
#   3. Cloud Tasks queue backlog / oldest task arrival age
#   4. Cloud SQL connection saturation (>80% of db_max_connections) or readiness DB failures

resource "google_logging_metric" "db_readiness_failures" {
  name        = "${local.prefix}-db-readiness-failures"
  description = "Counts Cloud Run readiness database check failures"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name=~"^${local.prefix}-(api|worker)$"
    jsonPayload.message=~"Readiness database check failed"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "api_5xx_errors" {
  display_name          = "[${var.environment}] ${var.name_prefix} API/Worker 5xx Errors"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels

  conditions {
    display_name = "Cloud Run 5xx response count > 5 in 5m"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = monitoring.regex.full_match(\"${local.prefix}-(api|worker)\") AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "job_execution_failures" {
  display_name          = "[${var.environment}] ${var.name_prefix} Cloud Run Job Failure"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels

  conditions {
    display_name = "Any Cloud Run Job execution failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = monitoring.regex.full_match(\"${local.prefix}-.*\") AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "tasks_backlog" {
  display_name          = "[${var.environment}] ${var.name_prefix} Cloud Tasks Queue Backlog"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels

  conditions {
    display_name = "HarnessRouter queue depth > 50 for 10m"
    condition_threshold {
      filter          = "resource.type = \"cloud_tasks_queue\" AND resource.labels.queue_id = \"${google_cloud_tasks_queue.harness_tasks.name}\" AND metric.type = \"cloudtasks.googleapis.com/queue/depth\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 50

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "cloudsql_connections" {
  display_name          = "[${var.environment}] ${var.name_prefix} Cloud SQL High Connections"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels

  conditions {
    display_name = "PostgreSQL active backends > 80% of db_max_connections"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${var.project_id}:${local.cloud_sql_instance_name}\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = floor(var.db_max_connections * 0.8)

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  depends_on = [google_project_service.required]
}
