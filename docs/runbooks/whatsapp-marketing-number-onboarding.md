# Local Runbook: Start Platform, Onboard WhatsApp Marketing Number, and Validate All Services

## Summary

Use Docker Compose to bring up the full stack, onboard a tenant + WhatsApp marketing number, then validate all exposed and internal services.
This runbook is aligned to the current repo state (including current port mappings and onboarding flow).

Automation helpers:

- `scripts/local-runbook-e2e.sh` (runs startup + onboarding + validations)
- `scripts/bootstrap-marketing-number.sh` (runs only WhatsApp number onboarding + channel attach)

## Public Interfaces Used

- External API/UI:
  - `http://localhost` (edge proxy + web + `/api`)
  - `http://localhost:18080` (`api-gateway` direct)
  - `http://localhost:3001` (`web-portal` direct)
- Core API routes:
  - `/api/v1/tenants`, `/api/v1/users`, `/api/v1/channels/whatsapp`, `/api/v1/templates`, `/api/v1/campaigns`, `/api/v1/contacts`, `/api/v1/analytics`, `/api/v1/audit`
  - `GET/POST /api/v1/webhooks/meta/whatsapp`
- Internal onboarding routes (via Docker network):
  - `meta-adapter`:
    - `/internal/v1/whatsapp/subscribe-app`
    - `/internal/v1/whatsapp/phone-numbers`
    - `/internal/v1/whatsapp/register-number`

## Execution Steps

1. Prepare environment

```bash
cp .env.example .env
```

Set real values in `.env` for:

- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_REGISTER_PIN`
- `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`
- Strong non-default infra passwords (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_DEFAULT_PASS`, etc.)

2. Start all services

```bash
docker compose up --build -d
docker compose ps
```

3. Open all externally available services

- App via edge proxy: `http://localhost`
- API direct: `http://localhost:18080/health`
- Web portal direct: `http://localhost:3001`
- Keycloak: `http://localhost:8081`
- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- RabbitMQ UI: `http://localhost:15672`
- MinIO API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001`
- OpenSearch: `http://localhost:9200`
- Vault (dev): `http://localhost:8200`

4. Health checks

```bash
curl http://localhost:18080/health
curl http://localhost:3001/health
curl -A "Mozilla/5.0" http://localhost/health
```

Note: `http://localhost` with default curl user-agent may return `403` due nginx bot filtering.

5. Tenant onboarding

```bash
TENANT_ID=$(curl -s -X POST http://localhost:18080/api/v1/tenants \
  -H 'content-type: application/json' \
  -H 'x-role: platform_owner' \
  -d '{"name":"Acme Commerce"}' | jq -r '.id')

curl -s -X POST http://localhost:18080/api/v1/users \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d '{"email":"admin@acme.example","displayName":"Acme Admin","roles":["tenant_admin","marketing_manager"]}'
```

6. WhatsApp marketing number onboarding

```bash
APP_NET=$(docker network ls --format '{{.Name}}' | grep '_app-net$' | head -n1)

# subscribe app to WABA
docker run --rm --network "$APP_NET" curlimages/curl:8.8.0 -sS -X POST \
  http://meta-adapter:8092/internal/v1/whatsapp/subscribe-app \
  -H 'content-type: application/json' \
  -d "{\"wabaId\":\"${WHATSAPP_WABA_ID}\"}"

# fetch phone numbers
docker run --rm --network "$APP_NET" curlimages/curl:8.8.0 -sS \
  "http://meta-adapter:8092/internal/v1/whatsapp/phone-numbers?wabaId=${WHATSAPP_WABA_ID}"

# register number
docker run --rm --network "$APP_NET" curlimages/curl:8.8.0 -sS -X POST \
  http://meta-adapter:8092/internal/v1/whatsapp/register-number \
  -H 'content-type: application/json' \
  -d "{\"phoneNumberId\":\"${WHATSAPP_PHONE_NUMBER_ID}\",\"pin\":\"${WHATSAPP_REGISTER_PIN}\"}"

# attach channel to tenant
curl -s -X POST http://localhost:18080/api/v1/channels/whatsapp \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"wabaId\":\"${WHATSAPP_WABA_ID}\",\"phoneNumberId\":\"${WHATSAPP_PHONE_NUMBER_ID}\",\"displayPhoneNumber\":\"+1XXXXXXXXXX\"}"
```

7. Template, contact, campaign, dispatch

```bash
TEMPLATE_ID=$(curl -s -X POST http://localhost:18080/api/v1/templates \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d '{"name":"summer_offer_v1","category":"marketing","language":"en","body":"Hi {{1}}, enjoy 20% off today."}' | jq -r '.id')

CONTACT_PHONE="+15551234567"

CAMPAIGN_ID=$(curl -s -X POST http://localhost:18080/api/v1/campaigns \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H "x-tenant-id: ${TENANT_ID}" \
  -d "{\"name\":\"Warmup Batch 1\",\"templateId\":\"${TEMPLATE_ID}\",\"templateName\":\"summer_offer_v1\",\"templateLanguage\":\"en\",\"templateCategory\":\"marketing\"}" | jq -r '.id')

curl -s -X POST "http://localhost:18080/api/v1/campaigns/${CAMPAIGN_ID}/dispatch" \
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
  }"
```

8. Validate all app services (internal + external)

```bash
docker compose ps
curl -s http://localhost:18080/api/v1/analytics -H "x-role: analyst" -H "x-tenant-id: ${TENANT_ID}"
curl -s http://localhost:18080/api/v1/audit -H "x-role: compliance_auditor" -H "x-tenant-id: ${TENANT_ID}"
docker compose logs --tail 100 api-gateway webhook-ingestor notification-worker meta-adapter campaign-service
```

## Test Cases and Scenarios

- Startup: all containers `Up` in `docker compose ps`.
- Gateway health: `GET /health` returns `200`.
- RBAC: tenant creation works with `x-role: platform_owner`; restricted roles fail appropriately.
- Onboarding: subscribe/register/channel attach succeed with valid Meta credentials.
- Campaign flow: template + campaign + dispatch returns success, then audit and analytics reflect activity.
- Webhook readiness: verify token path `GET /api/v1/webhooks/meta/whatsapp` responds correctly when Meta challenge is sent.

## Assumptions and Defaults

- Docker Desktop/Engine is running and internet egress to Graph API is allowed.
- You have valid Meta WABA credentials and app permissions.
- Current repo state is used as-is:
  - `api-gateway` host port is `18080` (not `8080`).
  - `meta-adapter` is internal-only (not directly published to host), so onboarding calls use Docker network access.
  - `redis-sentinel` containers may restart in current local setup; core onboarding flow still works via `redis-master`.
