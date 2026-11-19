#!/usr/bin/env bash
# Scan frontend static bundles or repository/container files for leaked secrets.
# Modes:
#   --frontend-bundle <paths...>  Strict browser bundle check: forbids backend secret env names AND values.
#   --repo <paths...>             Source/image check: forbids private keys, provider tokens, and hardcoded secrets.
set -euo pipefail

MODE="--repo"
if [ "${1:-}" = "--frontend-bundle" ] || [ "${1:-}" = "--repo" ]; then
  MODE="$1"
  shift
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 [--frontend-bundle|--repo] <dir_or_file> [...]" >&2
  exit 2
fi

if [ "$MODE" = "--frontend-bundle" ]; then
  FORBIDDEN_REGEX='(PLAID_SECRET|SECRET_BOX_KEY|ALPACA_SECRET_KEY|APCA-API-SECRET-KEY|HARNESSROUTER_API_KEY|TOKENROUTER_API_KEY|WORKER_TOKEN|sk-(hr-)?[A-Za-z0-9_-]{20,}|access-sandbox-[A-Za-z0-9_-]+|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|postgresql://[^"[:space:]]+:[^"[:space:]]+@)'
else
  FORBIDDEN_REGEX='(sk-(hr-)?[A-Za-z0-9_-]{20,}|access-sandbox-[A-Za-z0-9_-]{6,}|public-sandbox-[A-Za-z0-9_-]{6,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|(PLAID_SECRET|SECRET_BOX_KEY|ALPACA_SECRET_KEY|HARNESSROUTER_API_KEY|TOKENROUTER_API_KEY|WORKER_TOKEN)[[:space:]]*=[[:space:]]*["'\''][A-Za-z0-9_=-]{12,}["'\''])'
fi

found=0
for target in "$@"; do
  if [ ! -e "$target" ]; then
    continue
  fi
  if grep -RInE "$FORBIDDEN_REGEX" "$target" >/dev/null 2>&1; then
    echo "ERROR: Forbidden secret pattern (${MODE}) detected inside '${target}'!" >&2
    grep -RInlE "$FORBIDDEN_REGEX" "$target" >&2 || true
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  exit 1
fi

echo "Secret scan (${MODE}) passed cleanly."
