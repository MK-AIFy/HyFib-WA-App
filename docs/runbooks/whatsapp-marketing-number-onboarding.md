# Runbook: Setup and Use a New Marketing Number End-to-End

This runbook maps Meta WhatsApp Business Platform actions to this application (`api-gateway`, `meta-adapter`, `webhook-ingestor`) so a tenant can go live safely.

## 0) Prerequisites

- Meta Business Portfolio verified and owns target WABA.
- App is created in Meta Developer Dashboard with WhatsApp product.
- Production credentials are stored in Vault, injected into `.env` at runtime only.
- Public HTTPS webhook URL points to your edge proxy: `https://<your-domain>/api/v1/webhooks/meta/whatsapp`.
- Tenant and platform owner user exist in this app.

## 1) Seed Tenant and Role Context in Platform

Create tenant:

```bash
curl -X POST http://localhost/api/v1/tenants \
  -H 'content-type: application/json' \
  -H 'x-role: platform_owner' \
  -d '{"name":"Acme Commerce"}'
```

Create admin user for that tenant:

```bash
curl -X POST http://localhost/api/v1/users \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{"email":"admin@acme.example","displayName":"Acme Admin","roles":["tenant_admin","marketing_manager"]}'
```

## 2) Configure Secrets (Vault-first)

Required secrets:

- `WHATSAPP_ACCESS_TOKEN`
- `META_APP_SECRET`
- `WHATSAPP_WABA_ID`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_REGISTER_PIN`
- `WEBHOOK_VERIFY_TOKEN`

Never persist these in DB or source-controlled files.

## 3) Subscribe App to WABA

```bash
curl -X POST http://localhost:8092/internal/v1/whatsapp/subscribe-app \
  -H 'content-type: application/json' \
  -d '{"wabaId":"<WABA_ID>"}'
```

## 4) Fetch Phone Number Metadata

```bash
curl "http://localhost:8092/internal/v1/whatsapp/phone-numbers?wabaId=<WABA_ID>"
```

Capture `phone_number_id` for onboarding.

## 5) Register Production Number

```bash
curl -X POST http://localhost:8092/internal/v1/whatsapp/register-number \
  -H 'content-type: application/json' \
  -d '{"phoneNumberId":"<PHONE_NUMBER_ID>","pin":"<PIN>"}'
```

## 6) Attach Channel to Tenant in Platform

```bash
curl -X POST http://localhost/api/v1/channels/whatsapp \
  -H 'content-type: application/json' \
  -H 'x-role: tenant_admin' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{"wabaId":"<WABA_ID>","phoneNumberId":"<PHONE_NUMBER_ID>","displayPhoneNumber":"+1XXXXXXXXXX"}'
```

## 7) Configure and Verify Webhook

Meta verification call must hit:

`GET /api/v1/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=<CHALLENGE>`

Set `WEBHOOK_VERIFY_TOKEN` in runtime to the same token used in Meta webhook setup.

## 8) Enable Required Webhook Subscriptions in Meta

Enable events used by platform operations:

- messages (inbound)
- message status (sent, delivered, read, failed)
- template status updates
- account/quality related events

## 9) Configure Billing in Meta

Complete Business Manager payment setup before scaled sends.

## 10) Create Approved Marketing Templates

Create templates in WhatsApp Manager, then mirror in platform:

```bash
curl -X POST http://localhost/api/v1/templates \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{"name":"summer_offer_v1","category":"marketing","language":"en","body":"Hi {{1}}, enjoy 20% off today."}'
```

## 11) Create Contact + Campaign

```bash
curl -X POST http://localhost/api/v1/contacts \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{"phoneE164":"+15551234567","firstName":"Sam","country":"US","tags":["warmup"]}'
```

```bash
curl -X POST http://localhost/api/v1/campaigns \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{"name":"Warmup Batch 1","templateId":"<TEMPLATE_ID>","templateName":"summer_offer_v1","templateLanguage":"en","templateCategory":"marketing"}'
```

## 12) Dispatch Controlled Test

```bash
curl -X POST http://localhost/api/v1/campaigns/<CAMPAIGN_ID>/dispatch \
  -H 'content-type: application/json' \
  -H 'x-role: marketing_manager' \
  -H 'x-tenant-id: <TENANT_ID>' \
  -d '{
    "contactPhoneE164":"+15551234567",
    "parameters":["Sam"],
    "hasActiveConsent":true,
    "isOptedOut":false,
    "isInside24hWindow":false,
    "currentHourLocal":14,
    "quietHours":{"startHour":21,"endHour":8},
    "frequencyCap":{"maxMessages":2,"periodHours":24,"sentInPeriod":0}
  }'
```

## 13) Validate Delivery Events

- `api-gateway` validates Meta signature and idempotency.
- `webhook-ingestor` deduplicates and emits status/inbound events.
- Check tenant audit trail:

```bash
curl http://localhost/api/v1/audit \
  -H 'x-role: compliance_auditor' \
  -H 'x-tenant-id: <TENANT_ID>'
```

## 14) Move to Live Permissions and Production Mode

Complete Meta app review and switch app configuration to production mode.

## 15) Enable Guardrails Before Scale

Mandatory controls:

- consent proof required
- quiet hours
- frequency caps
- strict template category matching
- STOP/opt-out immediate suppression

## 16) Warm-up Strategy (2 Weeks)

- Week 1: low-risk segments, low volume, long spacing.
- Week 2: gradual ramp only if delivery and complaint metrics remain healthy.

## 17) Expand Campaign Throughput Gates

Scale only after:

- stable quality rating
- low failure/retry rates
- opt-out ratio inside tenant thresholds

## 18) Continuous Monitoring

Monitor:

- webhook lag and duplicate rate
- dispatch failures and Graph API errors
- opt-out and complaint trends
- campaign performance and delivery quality
