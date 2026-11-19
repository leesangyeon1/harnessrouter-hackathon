output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository path."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${local.artifact_registry_repo_id}"
}

output "api_service_url" {
  description = "Public HTTPS URL of the FastAPI Cloud Run service."
  value       = google_cloud_run_v2_service.api.uri
}

output "worker_service_url" {
  description = "Private HTTPS URL of the HarnessRouter Cloud Run worker service (OIDC IAM gated)."
  value       = google_cloud_run_v2_service.worker.uri
}

output "web_service_url" {
  description = "Public HTTPS URL of the Next.js UI Cloud Run service (when deploy_web_service = true)."
  value       = var.deploy_web_service ? google_cloud_run_v2_service.web[0].uri : null
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)."
  value       = local.cloud_sql_connection_name
}

output "cloud_tasks_queue_id" {
  description = "Cloud Tasks queue resource ID for HarnessRouter async tasks."
  value       = google_cloud_tasks_queue.harness_tasks.id
}

output "secret_manager_secret_ids" {
  description = "Secret Manager secret IDs expecting out-of-band secret versions."
  value       = { for k, s in google_secret_manager_secret.managed : k => s.secret_id }
}

output "cicd_deployer_service_account" {
  description = "Service account email for GitHub Actions OIDC deployments."
  value       = google_service_account.cicd.email
}

output "estimated_peak_db_connections" {
  description = "Worst-case PostgreSQL connection count across all Cloud Run services, jobs, and reserve."
  value       = local.estimated_peak_db_connections
}
