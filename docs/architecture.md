# Architecture Overview

## Goals

- On-prem VM deployment with Docker Compose.
- Multi-tenant, multi-user platform with hybrid tenant isolation.
- 99.95% availability target with RPO <= 5m, RTO <= 30m.
- Medium scale target: up to ~2M outbound messages/month and ~500 concurrent users.
- WhatsApp Cloud API messaging with strict policy controls.
- Claude Opus used only for backoffice intelligence.

## Logical Architecture

1. Edge/DMZ:
- Active/passive reverse-proxy and WAF nodes.
- TLS 1.3 termination and strict inbound controls.
- Meta webhook source filtering and rate limiting.

2. Application plane (consolidated to six runtime services):
- `api-gateway` — authenticated, PostgreSQL-backed core API (tenants, users,
  channels, templates, campaigns, contacts, orders, analytics, audit, webhooks)
  and the transactional-outbox relay.
- `web-portal` — operator UI.
- `meta-adapter` — WhatsApp Cloud API integration (resilient: retry/backoff +
  circuit breaker). Sends templates (positional or structured components),
  free-form session text/media, interactive button/list menus, read receipts,
  and lists templates for sync. Each call accepts a per-channel access token.
- `webhook-ingestor` — inbound webhook HMAC verification + full payload
  normalization (text, media, interactive/button replies, location, reactions,
  contacts, referrals, context, profile name; status pricing/category/errors).
- `notification-worker` (message-worker) — consumes campaign/outbound/inbound/
  status events; sends templates and agent replies using the channel's number +
  decrypted token, persists conversations + messages + enriched statuses, and
  marks inbound messages read.
- `ai-intelligence-service` — internal backoffice intelligence.

The earlier per-domain microservices (`auth/tenant/contact/conversation/campaign/
template/commerce/billing/reporting/audit-service`) were empty stubs and have
been consolidated into `api-gateway`. Identity is delegated to Keycloak.

3. Data plane:
- PostgreSQL 16 with replication topology.
- Redis 7 with Sentinel.
- RabbitMQ quorum queues.
- MinIO for artifacts and media.
- OpenSearch for indexed logs/search workloads.

4. Control plane:
- Keycloak for OIDC/SAML.
- Vault for secrets and rotation workflows.
- Prometheus/Grafana for metrics and SLO dashboards.

## Tenant Isolation Strategy

- Shared control-plane services.
- Tenant-scoped business data with tenant IDs and mandatory access checks.
- Sensitive data fields encrypted with tenant-specific keys.
- Immutable audit logs with actor/tenant attribution.

## Messaging Flow

Outbound (campaign dispatch):
1. Authenticated dispatch request enters `api-gateway`.
2. Policy checks validate consent, opt-out (from stored contacts), template
   category, quiet hours, and frequency constraints.
3. In one DB transaction the gateway sets the campaign `running` and writes a
   `campaign.dispatch.requested` row to the **outbox**; it returns `202 Accepted`.
4. The gateway's **outbox relay** publishes pending rows to RabbitMQ (durable
   topic exchange, publisher confirms) and marks them processed.
5. `notification-worker` consumes the event (idempotent via `campaign_send_log`),
   calls `meta-adapter`, and persists an outbound `message` with the
   `external_message_id`, then publishes `campaign.dispatch.result`.

Inbound + status:
6. Meta calls the webhook; `api-gateway` verifies HMAC and forwards to
   `webhook-ingestor`, which re-verifies, deduplicates, and publishes
   `whatsapp.inbound.received` / `whatsapp.status.updated`.
7. `notification-worker` consumes these, resolves the tenant/channel from the
   `phone_number_id` (RLS-safe `SECURITY DEFINER` function), upserts the contact +
   conversation, records the inbound message, and updates delivery status by
   `external_message_id`.

See [`event-architecture.md`](event-architecture.md) for the full eventing design.

## Web Access Flow

1. User opens `edge-proxy` root URL.
2. Nginx routes `/` to `web-portal` and `/api/*` to `api-gateway`.
3. `api-gateway` enforces role-based checks and tenant scoping.
4. Downstream services process commands via internal HTTP and event bus contracts.

## Event Contracts

- `whatsapp.inbound.received`
- `whatsapp.status.updated`
- `template.status.updated`
- `campaign.dispatch.requested`
- `campaign.dispatch.result`
- `commerce.order.event`
- `compliance.optout.event`

## Security Baselines

- Mandatory webhook signature validation (`X-Hub-Signature-256`).
- Idempotency handling on webhook and outbound dispatch paths.
- Least privilege service tokens and network segmentation.
- Secrets stored only in Vault, never plaintext in DB.

## AI Backoffice Boundaries

- Claude Opus powers internal drafting, segmentation heuristics, and analytics summarization.
- AI output is advisory and never bypasses deterministic policy checks.
- Business Solution Data is not allowed for external model training.
