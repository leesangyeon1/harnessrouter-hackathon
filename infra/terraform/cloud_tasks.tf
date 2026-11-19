# Cloud Tasks queue for HTTP-decoupled HarnessRouter tasks (`agent_tasks`).
# Worker side enforces tenant-scoped idempotency on `agent_tasks.id` + `idempotency_key`
# so at-least-once Cloud Tasks retries never duplicate HarnessRouter executions or charges.

resource "google_cloud_tasks_queue" "harness_tasks" {
  name     = "${local.prefix}-harness-tasks"
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.tasks_max_dispatches_per_second
    max_concurrent_dispatches = var.tasks_max_concurrent_dispatches
  }

  retry_config {
    max_attempts       = var.tasks_max_attempts
    max_retry_duration = var.tasks_max_retry_duration
    min_backoff        = var.tasks_min_backoff
    max_backoff        = var.tasks_max_backoff
    max_doublings      = var.tasks_max_doublings
  }

  stackdriver_logging_config {
    sampling_ratio = 1.0
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_tasks_queue_iam_member" "api_enqueuer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.harness_tasks.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.api.email}"
}
