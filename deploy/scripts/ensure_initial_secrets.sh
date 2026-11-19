#!/usr/bin/env bash
# Idempotently populate version 1 of Secret Manager secrets ONLY when a secret has no versions yet.
# Never overwrites existing secret versions and never prints secret material to stdout/stderr.
set -euo pipefail

GCP_PROJECT_ID="${1:?Pass GCP_PROJECT_ID as arg 1}"
GCP_REGION="${2:?Pass GCP_REGION as arg 2}"
ENV_NAME="${3:?Pass ENV_NAME as arg 3}"
NAME_PREFIX="${4:-hr-finance}"

PREFIX="${NAME_PREFIX}-${ENV_NAME}"
SQL_INSTANCE="${PREFIX}-pg16"
CONN_NAME="${GCP_PROJECT_ID}:${GCP_REGION}:${SQL_INSTANCE}"

has_version() {
  local secret_id="$1"
  local existing
  existing="$(gcloud secrets versions list "${secret_id}" \
    --project="${GCP_PROJECT_ID}" \
    --filter="state=ENABLED" \
    --limit=1 \
    --format="value(name)" 2>/dev/null || true)"
  [ -n "${existing}" ]
}

add_secret_stdin() {
  local secret_id="$1"
  gcloud secrets versions add "${secret_id}" \
    --project="${GCP_PROJECT_ID}" \
    --data-file=- >/dev/null
}

gen_token() {
  python3 -c "import secrets; print(secrets.token_urlsafe(24), end='')"
}

# 1. Migrator DB user (Cloud SQL built-in user with CREATEROLE to own schema & create runtime roles)
if ! has_version "${PREFIX}-db-url-migrator"; then
  echo "==> Initializing ${PREFIX}-db-url-migrator and Cloud SQL user finance_migrator..."
  MIG_PW="$(gen_token)"
  if gcloud sql users list --instance="${SQL_INSTANCE}" --project="${GCP_PROJECT_ID}" \
    --format="value(name)" | grep -qx "finance_migrator"; then
    gcloud sql users set-password finance_migrator \
      --instance="${SQL_INSTANCE}" \
      --project="${GCP_PROJECT_ID}" \
      --password="${MIG_PW}" >/dev/null
  else
    gcloud sql users create finance_migrator \
      --instance="${SQL_INSTANCE}" \
      --project="${GCP_PROJECT_ID}" \
      --password="${MIG_PW}" >/dev/null
  fi
  printf 'postgresql://finance_migrator:%s@/finance?host=/cloudsql/%s' "${MIG_PW}" "${CONN_NAME}" \
    | add_secret_stdin "${PREFIX}-db-url-migrator"
  unset MIG_PW
fi

# 2. Pure-SQL runtime DB URLs (roles created with NOBYPASSRLS by finance_api.bootstrap_roles)
for pair in \
  "db-url-api:finance_api_app" \
  "db-url-cycle:finance_cycle_app" \
  "db-url-executor:finance_executor_app"; do
  SECRET_SUFFIX="${pair%%:*}"
  DB_USER="${pair##*:}"
  if ! has_version "${PREFIX}-${SECRET_SUFFIX}"; then
    echo "==> Initializing ${PREFIX}-${SECRET_SUFFIX} (${DB_USER})..."
    APP_PW="$(gen_token)"
    printf 'postgresql://%s:%s@/finance?host=/cloudsql/%s' "${DB_USER}" "${APP_PW}" "${CONN_NAME}" \
      | add_secret_stdin "${PREFIX}-${SECRET_SUFFIX}"
    unset APP_PW
  fi
done

# 3. Fernet SecretBox key (32 random bytes, URL-safe base64)
if ! has_version "${PREFIX}-secret-box-key"; then
  echo "==> Initializing ${PREFIX}-secret-box-key..."
  python3 -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode(), end='')" \
    | add_secret_stdin "${PREFIX}-secret-box-key"
fi

# 4. External Sandbox / Paper API placeholders (only when unpopulated; replace out-of-band for provider calls)
for ext_secret in \
  "plaid-client-id" \
  "plaid-secret" \
  "alpaca-data-api-key" \
  "alpaca-data-secret-key" \
  "harnessrouter-api-key"; do
  if ! has_version "${PREFIX}-${ext_secret}"; then
    echo "==> Initializing placeholder for ${PREFIX}-${ext_secret}..."
    printf 'unconfigured-replace-in-secret-manager' | add_secret_stdin "${PREFIX}-${ext_secret}"
  fi
done

echo "==> All Secret Manager secrets for ${PREFIX} have active versions."
