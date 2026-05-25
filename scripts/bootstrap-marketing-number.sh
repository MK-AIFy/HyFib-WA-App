#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BASE_URL:-}" ]]; then
  echo "BASE_URL is required (example: http://localhost)"
  exit 1
fi
if [[ -z "${TENANT_ID:-}" ]]; then
  echo "TENANT_ID is required"
  exit 1
fi
if [[ -z "${WABA_ID:-}" ]]; then
  echo "WABA_ID is required"
  exit 1
fi
if [[ -z "${PHONE_NUMBER_ID:-}" ]]; then
  echo "PHONE_NUMBER_ID is required"
  exit 1
fi
if [[ -z "${REGISTER_PIN:-}" ]]; then
  echo "REGISTER_PIN is required"
  exit 1
fi

echo "[1/4] Subscribe app to WABA"
curl -sS -X POST "${BASE_URL}:8092/internal/v1/whatsapp/subscribe-app" \
  -H 'content-type: application/json' \
  -d "{\"wabaId\":\"${WABA_ID}\"}" | jq .

echo "[2/4] Register phone number"
curl -sS -X POST "${BASE_URL}:8092/internal/v1/whatsapp/register-number" \
  -H 'content-type: application/json' \
  -d "{\"phoneNumberId\":\"${PHONE_NUMBER_ID}\",\"pin\":\"${REGISTER_PIN}\"}" | jq .

echo "[3/4] Attach WhatsApp channel to tenant"
curl -sS -X POST "${BASE_URL}/api/v1/channels/whatsapp" \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"wabaId\":\"${WABA_ID}\",\"phoneNumberId\":\"${PHONE_NUMBER_ID}\",\"displayPhoneNumber\":\"${DISPLAY_PHONE_NUMBER:-+10000000000}\"}" | jq .

echo "[4/4] List channels"
curl -sS "${BASE_URL}/api/v1/channels/whatsapp" \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" | jq .
