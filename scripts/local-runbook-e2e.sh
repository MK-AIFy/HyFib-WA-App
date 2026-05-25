#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required"
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd jq

BASE_URL="${BASE_URL:-http://localhost:18080}"
BASE_URL="${BASE_URL%/}"
EDGE_URL="${EDGE_URL:-http://localhost}"
WEB_PORTAL_URL="${WEB_PORTAL_URL:-http://localhost:3001}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.8.0}"
TENANT_NAME="${TENANT_NAME:-Acme Commerce}"
TENANT_ADMIN_EMAIL="${TENANT_ADMIN_EMAIL:-admin@acme.example}"
TENANT_ADMIN_NAME="${TENANT_ADMIN_NAME:-Acme Admin}"
DISPLAY_PHONE_NUMBER="${DISPLAY_PHONE_NUMBER:-+1XXXXXXXXXX}"
CONTACT_PHONE="${CONTACT_PHONE:-+15551234567}"

if [[ ! -f .env ]]; then
  echo "[0/8] .env missing; creating from .env.example"
  cp .env.example .env
fi

if [[ "${SKIP_COMPOSE_UP:-}" != "1" && "${SKIP_COMPOSE_UP:-}" != "true" ]]; then
  echo "[1/8] Starting compose stack"
  docker compose up --build -d
fi

echo "[2/8] Compose status"
docker compose ps

echo "[3/8] External health checks"
curl -fsS "${BASE_URL}/health" | jq .
curl -fsS "${WEB_PORTAL_URL}/health" | jq .
curl -fsS -A "Mozilla/5.0" "${EDGE_URL}/health" | jq .

echo "[4/8] Tenant onboarding"
TENANT_ID="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/tenants" \
    -H 'content-type: application/json' \
    -H 'x-role: platform_owner' \
    -d "{\"name\":\"${TENANT_NAME}\"}" | jq -r '.id // empty'
)"
if [[ -z "${TENANT_ID}" ]]; then
  echo "Failed to create tenant"
  exit 1
fi
echo "TENANT_ID=${TENANT_ID}"

curl -fsS -X POST "${BASE_URL}/api/v1/users" \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"email\":\"${TENANT_ADMIN_EMAIL}\",\"displayName\":\"${TENANT_ADMIN_NAME}\",\"roles\":[\"tenant_admin\",\"marketing_manager\"]}" | jq .

echo "[5/8] WhatsApp number onboarding"
require_env WHATSAPP_WABA_ID
require_env WHATSAPP_PHONE_NUMBER_ID
require_env WHATSAPP_REGISTER_PIN

APP_NET="$(docker network ls --format '{{.Name}}' | grep '_app-net$' | head -n1 || true)"
if [[ -z "${APP_NET}" ]]; then
  echo "Could not detect app network (*_app-net)."
  exit 1
fi
echo "APP_NET=${APP_NET}"

docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -fsS -X POST \
  "http://meta-adapter:8092/internal/v1/whatsapp/subscribe-app" \
  -H 'content-type: application/json' \
  -d "{\"wabaId\":\"${WHATSAPP_WABA_ID}\"}" | jq .

docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -fsS \
  "http://meta-adapter:8092/internal/v1/whatsapp/phone-numbers?wabaId=${WHATSAPP_WABA_ID}" | jq .

docker run --rm --network "${APP_NET}" "${CURL_IMAGE}" -fsS -X POST \
  "http://meta-adapter:8092/internal/v1/whatsapp/register-number" \
  -H 'content-type: application/json' \
  -d "{\"phoneNumberId\":\"${WHATSAPP_PHONE_NUMBER_ID}\",\"pin\":\"${WHATSAPP_REGISTER_PIN}\"}" | jq .

curl -fsS -X POST "${BASE_URL}/api/v1/channels/whatsapp" \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"wabaId\":\"${WHATSAPP_WABA_ID}\",\"phoneNumberId\":\"${WHATSAPP_PHONE_NUMBER_ID}\",\"displayPhoneNumber\":\"${DISPLAY_PHONE_NUMBER}\"}" | jq .

echo "[6/8] Template, campaign, dispatch"
TEMPLATE_ID="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/templates" \
    -H 'content-type: application/json' \
    -H 'x-role: marketing_manager' \
    -H "x-tenant-id: ${TENANT_ID}" \
    -d '{"name":"summer_offer_v1","category":"marketing","language":"en","body":"Hi {{1}}, enjoy 20% off today."}' | jq -r '.id // empty'
)"
if [[ -z "${TEMPLATE_ID}" ]]; then
  echo "Failed to create template"
  exit 1
fi
echo "TEMPLATE_ID=${TEMPLATE_ID}"

CAMPAIGN_ID="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/campaigns" \
    -H 'content-type: application/json' \
    -H 'x-role: marketing_manager' \
    -H "x-tenant-id: ${TENANT_ID}" \
    -d "{\"name\":\"Warmup Batch 1\",\"templateId\":\"${TEMPLATE_ID}\",\"templateName\":\"summer_offer_v1\",\"templateLanguage\":\"en\",\"templateCategory\":\"marketing\"}" | jq -r '.id // empty'
)"
if [[ -z "${CAMPAIGN_ID}" ]]; then
  echo "Failed to create campaign"
  exit 1
fi
echo "CAMPAIGN_ID=${CAMPAIGN_ID}"

curl -fsS -X POST "${BASE_URL}/api/v1/campaigns/${CAMPAIGN_ID}/dispatch" \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{
    \"contactPhoneE164\":\"${CONTACT_PHONE}\",
    \"parameters\":[\"Sam\"],
    \"hasActiveConsent\":true,
    \"isOptedOut\":false,
    \"isInside24hWindow\":false,
    \"currentHourLocal\":14,
    \"quietHours\":{\"startHour\":21,\"endHour\":8},
    \"frequencyCap\":{\"maxMessages\":2,\"periodHours\":24,\"sentInPeriod\":0}
  }" | jq .

echo "[7/8] Validate analytics + audit"
curl -fsS "${BASE_URL}/api/v1/analytics" \
  -H 'x-role: analyst' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .
curl -fsS "${BASE_URL}/api/v1/audit" \
  -H 'x-role: compliance_auditor' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .

echo "[8/8] Service logs"
docker compose logs --tail 100 api-gateway webhook-ingestor notification-worker meta-adapter campaign-service

echo
echo "Run completed."
echo "Tenant: ${TENANT_ID}"
