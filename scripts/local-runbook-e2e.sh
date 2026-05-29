#!/usr/bin/env bash
set -euo pipefail

# Local end-to-end runbook.
#
# This script exercises the platform with header-based identity, which the
# gateway only honours when AUTH_ENABLED=false. That is a LOCAL/DEV mode only.
# For production access, obtain a Keycloak token and use Authorization: Bearer
# (see docs/runbooks/keycloak-production.md).

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
require_cmd openssl

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
  echo "[0/9] .env missing; creating from .env.example"
  cp .env.example .env
fi

# This runbook uses header identity; force the local dev auth mode.
if grep -q '^AUTH_ENABLED=' .env; then
  sed -i.bak 's/^AUTH_ENABLED=.*/AUTH_ENABLED=false/' .env && rm -f .env.bak
else
  echo "AUTH_ENABLED=false" >>.env
fi

# Load META_APP_SECRET (for webhook signing) from .env.
META_APP_SECRET="$(grep -E '^META_APP_SECRET=' .env | head -n1 | cut -d= -f2-)"
META_APP_SECRET="${META_APP_SECRET:-replace-me}"

if [[ "${SKIP_COMPOSE_UP:-}" != "1" && "${SKIP_COMPOSE_UP:-}" != "true" ]]; then
  echo "[1/9] Starting compose stack"
  docker compose up --build -d
fi

echo "[2/9] Compose status"
docker compose ps

echo "[3/9] External health checks"
curl -fsS "${BASE_URL}/health" | jq .
curl -fsS "${WEB_PORTAL_URL}/health" | jq .
curl -fsS -A "Mozilla/5.0" "${EDGE_URL}/health" | jq .

echo "[4/9] Tenant onboarding"
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

echo "[5/9] WhatsApp number onboarding"
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

echo "[6/9] Template + campaign + async dispatch"
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

# Templates are created 'pending'; approve it directly in the DB for the local run
# (Meta template approval is asynchronous in real environments).
docker compose exec -T postgres-primary \
  psql -U "${POSTGRES_USER:-platform}" -d "${POSTGRES_DB:-hyfib_wa}" \
  -c "UPDATE templates SET status='approved' WHERE id='${TEMPLATE_ID}';" || true

CAMPAIGN_ID="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/campaigns" \
    -H 'content-type: application/json' \
    -H 'x-role: marketing_manager' \
    -H "x-tenant-id: ${TENANT_ID}" \
    -d "{\"name\":\"Warmup Batch 1\",\"templateId\":\"${TEMPLATE_ID}\"}" | jq -r '.id // empty'
)"
if [[ -z "${CAMPAIGN_ID}" ]]; then
  echo "Failed to create campaign"
  exit 1
fi
echo "CAMPAIGN_ID=${CAMPAIGN_ID}"

# Marketing requires a known, consented contact. Create one and record consent.
CONTACT_ID="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/contacts" \
    -H 'content-type: application/json' \
    -H 'x-role: marketing_manager' \
    -H "x-tenant-id: ${TENANT_ID}" \
    -d "{\"phoneE164\":\"${CONTACT_PHONE}\",\"firstName\":\"Sam\"}" | jq -r '.id // empty'
)"
if [[ -z "${CONTACT_ID}" ]]; then
  echo "Failed to create contact"
  exit 1
fi
echo "CONTACT_ID=${CONTACT_ID}"

curl -fsS -X POST "${BASE_URL}/api/v1/contacts/${CONTACT_ID}/consent" \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d '{"source":"e2e_runbook","policyVersion":"v1"}' | jq .

# Dispatch is asynchronous now: expect HTTP 202 + {status:"dispatch_enqueued"}.
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

echo "[7/9] Simulate a signed inbound webhook and confirm persistence"
INBOUND_PAYLOAD="$(jq -cn --arg pn "${WHATSAPP_PHONE_NUMBER_ID}" --arg from "${CONTACT_PHONE}" \
  '{entry:[{id:"waba",changes:[{value:{metadata:{phone_number_id:$pn},messages:[{id:"wamid.LOCAL1",from:$from,type:"text",text:{body:"hello there"},timestamp:"1700000000"}]}}]}]}')"
SIG="sha256=$(printf '%s' "${INBOUND_PAYLOAD}" | openssl dgst -sha256 -hmac "${META_APP_SECRET}" | awk '{print $2}')"
curl -fsS -X POST "${BASE_URL}/api/v1/webhooks/meta/whatsapp" \
  -H 'content-type: application/json' \
  -H "x-hub-signature-256: ${SIG}" \
  -d "${INBOUND_PAYLOAD}" | jq .
sleep 3
echo "Conversations for tenant (should contain the inbound message's conversation):"
curl -fsS "${BASE_URL}/api/v1/conversations" \
  -H 'x-role: support_agent' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .

echo "[8/9] Validate analytics + audit"
curl -fsS "${BASE_URL}/api/v1/analytics" \
  -H 'x-role: analyst' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .
curl -fsS "${BASE_URL}/api/v1/audit" \
  -H 'x-role: compliance_auditor' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .

echo "[9/9] Service logs"
docker compose logs --tail 100 api-gateway webhook-ingestor notification-worker meta-adapter

echo
echo "Run completed."
echo "Tenant: ${TENANT_ID}"
