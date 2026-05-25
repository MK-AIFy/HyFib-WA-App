#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:18080}"
BASE_URL="${BASE_URL%/}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.8.0}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required"
    exit 1
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd jq

require_env TENANT_ID
require_env WABA_ID
require_env PHONE_NUMBER_ID
require_env REGISTER_PIN

if [[ -z "${APP_NET:-}" ]]; then
  APP_NET="$(docker network ls --format '{{.Name}}' | grep '_app-net$' | head -n1 || true)"
fi
if [[ -z "${APP_NET:-}" ]]; then
  echo "APP_NET is required (or start compose stack to auto-detect *_app-net network)"
  exit 1
fi

echo "[1/4] Subscribe app to WABA"
docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -sS -X POST \
  "http://meta-adapter:8092/internal/v1/whatsapp/subscribe-app" \
  -H 'content-type: application/json' \
  -d "{\"wabaId\":\"${WABA_ID}\"}" | jq .

echo "[2/4] Fetch phone numbers"
docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -sS \
  "http://meta-adapter:8092/internal/v1/whatsapp/phone-numbers?wabaId=${WABA_ID}" | jq .

echo "[3/4] Register phone number"
docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -sS -X POST \
  "http://meta-adapter:8092/internal/v1/whatsapp/register-number" \
  -H 'content-type: application/json' \
  -d "{\"phoneNumberId\":\"${PHONE_NUMBER_ID}\",\"pin\":\"${REGISTER_PIN}\"}" | jq .

echo "[4/4] Attach WhatsApp channel to tenant"
curl -sS -X POST "${BASE_URL}/api/v1/channels/whatsapp" \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"wabaId\":\"${WABA_ID}\",\"phoneNumberId\":\"${PHONE_NUMBER_ID}\",\"displayPhoneNumber\":\"${DISPLAY_PHONE_NUMBER:-+10000000000}\"}" | jq .

echo "[done] List channels"
curl -sS "${BASE_URL}/api/v1/channels/whatsapp" \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .
