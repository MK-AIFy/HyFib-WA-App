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

2. Application plane:
- `web-portal`
- `api-gateway`
- `auth-service`
- `tenant-service`
- `contact-service`
- `conversation-service`
- `campaign-service`
- `template-service`
- `commerce-service`
- `billing-usage-service`
- `reporting-service`
- `audit-service`
- `meta-adapter`
- `webhook-ingestor`
- `notification-worker`
- `ai-intelligence-service`

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

1. Outbound campaign request enters `api-gateway`.
2. Policy checks validate consent, template category, rate/frequency constraints.
3. Command published to `campaign.dispatch.requested`.
4. `notification-worker` consumes command and calls `meta-adapter`.
5. `meta-adapter` sends Graph API request to WhatsApp Cloud API.
6. Delivery states arrive through webhook endpoint.
7. `webhook-ingestor` validates signature, deduplicates, publishes status event.
8. `conversation-service` and `reporting-service` update projections.

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
