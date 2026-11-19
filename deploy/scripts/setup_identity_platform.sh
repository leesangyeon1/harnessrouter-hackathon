#!/usr/bin/env bash
# Initialize Google Cloud Identity Platform Email/Password sign-in, authorized Cloud Run domains,
# and a restricted public Browser API Key (identitytoolkit + securetoken ONLY) for Next.js web/admin.
set -euo pipefail

GCP_PROJECT_ID="${1:?Pass GCP_PROJECT_ID as arg 1}"
ENV_NAME="${2:-dev}"
NAME_PREFIX="${3:-hr-finance}"
CLOUD_RUN_SUFFIX="${4:-wmu6zcvyfa-uc.a.run.app}"

PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"
TOKEN="$(gcloud auth print-access-token)"

PREFIX="${NAME_PREFIX}-${ENV_NAME}"
WEB_HASH_HOST="${PREFIX}-web-${CLOUD_RUN_SUFFIX}"
WEB_NUM_HOST="${PREFIX}-web-${PROJECT_NUMBER}.us-central1.run.app"
ADMIN_HASH_HOST="${PREFIX}-admin-${CLOUD_RUN_SUFFIX}"
ADMIN_NUM_HOST="${PREFIX}-admin-${PROJECT_NUMBER}.us-central1.run.app"
API_HASH_HOST="${PREFIX}-api-${CLOUD_RUN_SUFFIX}"
API_NUM_HOST="${PREFIX}-api-${PROJECT_NUMBER}.us-central1.run.app"
API_HASH_URL="https://${API_HASH_HOST}"

echo "==> Initializing Identity Platform on ${GCP_PROJECT_ID} (idempotent)..."
curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-goog-user-project: ${GCP_PROJECT_ID}" \
  -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/v2/projects/${GCP_PROJECT_ID}/identityPlatform:initializeAuth" \
  -d '{}' >/dev/null || true

echo "==> Configuring Email/Password sign-in & authorized Cloud Run domains..."
CONFIG_JSON="$(cat <<EOF
{
  "signIn": {
    "email": {
      "enabled": true,
      "passwordRequired": true
    }
  },
  "authorizedDomains": [
    "localhost",
    "127.0.0.1",
    "${GCP_PROJECT_ID}.firebaseapp.com",
    "${GCP_PROJECT_ID}.web.app",
    "${WEB_HASH_HOST}",
    "${WEB_NUM_HOST}",
    "${ADMIN_HASH_HOST}",
    "${ADMIN_NUM_HOST}",
    "${API_HASH_HOST}",
    "${API_NUM_HOST}"
  ]
}
EOF
)"

curl -fsS -X PATCH \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-goog-user-project: ${GCP_PROJECT_ID}" \
  -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${GCP_PROJECT_ID}/config?updateMask=signIn.email,authorizedDomains" \
  -d "${CONFIG_JSON}" >/dev/null

echo "==> Ensuring restricted public Identity Platform Browser API Key..."
EXISTING_KEY_NAME="$(gcloud services api-keys list \
  --project="${GCP_PROJECT_ID}" \
  --filter="displayName='Harness Identity Platform Web Key'" \
  --format="value(name)" | head -n 1)"

if [ -z "${EXISTING_KEY_NAME}" ]; then
  gcloud services api-keys create \
    --project="${GCP_PROJECT_ID}" \
    --display-name="Harness Identity Platform Web Key" \
    --api-target=service=identitytoolkit.googleapis.com \
    --api-target=service=securetoken.googleapis.com >/dev/null
  EXISTING_KEY_NAME="$(gcloud services api-keys list \
    --project="${GCP_PROJECT_ID}" \
    --filter="displayName='Harness Identity Platform Web Key'" \
    --format="value(name)" | head -n 1)"
fi

PUBLIC_WEB_API_KEY="$(gcloud services api-keys get-key-string "${EXISTING_KEY_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --format="value(keyString)")"

echo "==> Setting public Next.js build variables on GitHub repository..."
gh variable set NEXT_PUBLIC_API_BASE_URL --body "${API_HASH_URL}"
gh variable set IDENTITY_PROJECT_ID --body "${GCP_PROJECT_ID}"
gh variable set NEXT_PUBLIC_FIREBASE_API_KEY --body "${PUBLIC_WEB_API_KEY}"
gh variable set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN --body "${GCP_PROJECT_ID}.firebaseapp.com"
gh variable set NEXT_PUBLIC_ADMIN_URL --body "https://${ADMIN_HASH_HOST}"
gh variable set NEXT_PUBLIC_CUSTOMER_URL --body "https://${WEB_HASH_HOST}"
gh variable set ADMIN_APP_ORIGIN --body "https://${ADMIN_HASH_HOST}"
gh variable set CORS_ALLOWED_ORIGINS_JSON --body "[\"https://${WEB_HASH_HOST}\",\"https://${WEB_NUM_HOST}\"]"

echo "==> Identity Platform & GitHub public web variables configured!"
