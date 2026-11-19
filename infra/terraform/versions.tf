terraform {
  required_version = ">= 1.6.0"

  # Remote state bucket is passed via `terraform init -backend-config="bucket=..."`
  # so no unconfirmed bucket name is hardcoded in version control.
  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
