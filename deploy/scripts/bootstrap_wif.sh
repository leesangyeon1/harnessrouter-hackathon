#!/usr/bin/env bash
# One-time bootstrap for Terraform GCS remote state and GitHub Actions Workload Identity Federation.
# Does NOT create long-lived service account keys.
#
# Required environment variables:
#   GCP_PROJECT_ID        Target Google Cloud project ID (existing project with billing enabled)
#   GCP_REGION            Primary deployment region (e.g., us-central1)
#   TF_STATE_BUCKET       Globally unique GCS bucket name for Terraform state
#   GITHUB_REPOSITORY     GitHub owner/repo (default: leesangyeon1/harnessrouter-hackathon)
#   DEPLOY_BRANCHES_CSV   Allowed git refs, comma-separated (default: refs/heads/main,refs/heads/dev)

set -euo pipefail

GCP_PROJECT_ID="${1:-${GCP_PROJECT_ID:-}}"
GCP_REGION="${2:-${GCP_REGION:-}}"
TF_STATE_BUCKET="${3:-${TF_STATE_BUCKET:-}}"
: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID or pass as arg 1}"
: "${GCP_REGION:?Set GCP_REGION or pass as arg 2}"
: "${TF_STATE_BUCKET:?Set TF_STATE_BUCKET or pass as arg 3}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-leesangyeon1/harnessrouter-hackathon}"
DEPLOY_BRANCHES_CSV="${DEPLOY_BRANCHES_CSV:-refs/heads/main,refs/heads/dev}"

POOL_ID="github-actions-pool"
PROVIDER_ID="github-oidc"
CICD_SA_NAME="sa-cicd-deployer"
CICD_SA_EMAIL="${CICD_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Enabling bootstrap APIs on project ${GCP_PROJECT_ID}..."
gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  identitytoolkit.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  --project="${GCP_PROJECT_ID}"

PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"

echo "==> Ensuring Terraform state bucket gs://${TF_STATE_BUCKET}..."
if ! gcloud storage buckets describe "gs://${TF_STATE_BUCKET}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" --versioning --project="${GCP_PROJECT_ID}"

echo "==> Ensuring CI/CD deployer service account ${CICD_SA_EMAIL}..."
if ! gcloud iam service-accounts describe "${CICD_SA_EMAIL}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${CICD_SA_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --display-name="GitHub Actions CI/CD Deployer (OIDC only)"
fi

for role in \
  roles/viewer \
  roles/artifactregistry.admin \
  roles/run.admin \
  roles/cloudsql.admin \
  roles/secretmanager.admin \
  roles/cloudtasks.admin \
  roles/cloudscheduler.admin \
  roles/logging.configWriter \
  roles/monitoring.admin \
  roles/serviceusage.serviceUsageAdmin \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/resourcemanager.projectIamAdmin; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${CICD_SA_EMAIL}" \
    --role="${role}" \
    --quiet >/dev/null
done

gcloud storage buckets add-iam-policy-binding "gs://${TF_STATE_BUCKET}" \
  --member="serviceAccount:${CICD_SA_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --project="${GCP_PROJECT_ID}" \
  --quiet >/dev/null

echo "==> Ensuring Workload Identity Pool ${POOL_ID}..."
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${GCP_PROJECT_ID}" --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${GCP_PROJECT_ID}" \
    --location="global" \
    --display-name="GitHub Actions Pool"
fi

# Build CEL condition restricting OIDC tokens to this repository and allowed branches
IFS=',' read -r -a REFS <<< "${DEPLOY_BRANCHES_CSV}"
REF_CHECKS=""
for ref in "${REFS[@]}"; do
  trimmed="$(echo "${ref}" | xargs)"
  if [ -n "${REF_CHECKS}" ]; then
    REF_CHECKS="${REF_CHECKS} || "
  fi
  REF_CHECKS="${REF_CHECKS}assertion.ref == '${trimmed}'"
done
CEL_CONDITION="assertion.repository == '${GITHUB_REPOSITORY}' && (${REF_CHECKS})"

echo "==> Ensuring OIDC Provider ${PROVIDER_ID}..."
if ! gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${GCP_PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project="${GCP_PROJECT_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="GitHub OIDC Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="${CEL_CONDITION}"
else
  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" \
    --project="${GCP_PROJECT_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="${CEL_CONDITION}"
fi

for attempt in 1 2 3 4; do
  if gcloud iam service-accounts add-iam-policy-binding "${CICD_SA_EMAIL}" \
    --project="${GCP_PROJECT_ID}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}" \
    --quiet >/dev/null; then
    break
  fi
  echo "Waiting for IAM propagation (attempt ${attempt}/4)..."
  sleep 5
done

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

cat <<EOF

Bootstrap complete! Set the following GitHub Environment / Repository Variables (NOT Secrets):
  GCP_PROJECT_ID                 = ${GCP_PROJECT_ID}
  GCP_REGION                     = ${GCP_REGION}
  GCP_WORKLOAD_IDENTITY_PROVIDER = ${WIF_PROVIDER}
  GCP_DEPLOYER_SERVICE_ACCOUNT   = ${CICD_SA_EMAIL}
EOF
