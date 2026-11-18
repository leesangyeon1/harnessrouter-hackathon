resource "google_artifact_registry_repository" "containers" {
  count = var.create_artifact_registry ? 1 : 0

  location      = var.region
  repository_id = "${local.prefix}-containers"
  description   = "Container images for ${local.prefix} (web, api, worker, jobs)"
  format        = "DOCKER"
  labels        = local.labels

  cleanup_policies {
    id     = "delete-untagged-after-7d"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "keep-recent-30-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
    }
  }

  depends_on = [google_project_service.required]
}

locals {
  artifact_registry_repo_id = (
    var.create_artifact_registry
    ? google_artifact_registry_repository.containers[0].repository_id
    : var.existing_artifact_registry_repo_id
  )
}
