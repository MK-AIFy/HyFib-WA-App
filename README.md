# HyFib WhatsApp Business Platform

Production-grade on-prem multi-tenant WhatsApp Business Platform for marketing, sales, and e-commerce workflows with Claude Opus backoffice intelligence.

## What is included

- Multi-service Node.js/TypeScript monorepo with Docker Compose orchestration.
- Web-based multi-user `web-portal` with tenant/role context controls.
- WhatsApp Cloud API integration contract and webhook security baseline.
- Consent-first compliance controls (GDPR + India DPDP aligned).
- Campaign guardrails: opt-in enforcement, quiet hours, template category protection.
- AI intelligence service for internal operations only (no customer-facing AI bot mode).
- Observability stack: Prometheus + Grafana and OpenTelemetry plumbing.
- Security baselines: ASVS-focused app controls, SSDF-oriented SDLC controls, CIS-oriented container hardening notes.

## Core API contracts

Implemented at `api-gateway`:

- `/api/v1/tenants`
- `/api/v1/users`
- `/api/v1/channels/whatsapp`
- `/api/v1/templates`
- `/api/v1/campaigns`
- `/api/v1/contacts`
- `POST /api/v1/contacts/:id/consent` — record opt-in consent (required before marketing)
- `POST /api/v1/contacts/:id/opt-out` — revoke consent + suppress future sends
- `/api/v1/conversations`
- `GET /api/v1/conversations/:id/messages` — paginated history
- `POST /api/v1/conversations/:id/messages` — agent session reply (`kind`: `text` | `media` | `interactive`)
- `POST /api/v1/channels/whatsapp/:id/media` — upload raw file bytes to WhatsApp, returns a reusable `mediaId`
- `GET /api/v1/events/stream` — tenant-scoped Server-Sent Events stream of inbound messages and delivery statuses
- `/api/v1/orders`
- `/api/v1/analytics`
- `/api/v1/audit`
- `GET/POST /api/v1/webhooks/meta/whatsapp`

Campaign dispatch is consent-gated: a contact must exist and have active,
un-revoked consent (and not be opted out). Inbound **STOP** messages opt the
contact out automatically; **START** re-subscribes.

Web entrypoint:

- `/` via `web-portal` (proxied by `edge-proxy`)

## Architecture (consolidated)

Real logic is concentrated in a small set of services that are simple to run
and secure on a single on-prem host:

- `api-gateway` — authenticated, PostgreSQL-backed core API (tenants, users,
  channels, templates, campaigns, contacts, orders, analytics, audit, webhooks).
- `meta-adapter` — WhatsApp Cloud API integration.
- `webhook-ingestor` — inbound webhook ingestion with HMAC verification.
- `notification-worker` — template send execution.
- `ai-intelligence-service` — internal backoffice intelligence.
- `web-portal` — operator UI.

Authentication is performed against **Keycloak (OIDC/JWT)**; the gateway derives
tenant and roles from signed token claims (no header trust). All tenant data is
stored in PostgreSQL with **row-level security**, enforced by connecting as a
dedicated non-superuser role (`hyfib_app`).

## Quick start

1. Copy configuration and set non-default secrets (required in production):

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD, REDIS_PASSWORD,
# META_APP_SECRET, WEBHOOK_VERIFY_TOKEN, KEYCLOAK_ADMIN_PASSWORD, etc.
```

2. Generate a TLS certificate for the edge proxy (self-signed for local use;
   provision a CA-signed cert for production):

```bash
./scripts/generate-dev-tls-cert.sh
```

3. Build and run:

```bash
docker compose up --build -d
docker compose ps
```

4. Check health:

```bash
curl -k https://localhost/health        # via edge proxy (TLS)
curl http://localhost:18080/health      # api-gateway direct (DB-backed)
```

5. Open the web app: `https://localhost`

> Note: `/api/v1/*` endpoints require a valid Keycloak bearer token
> (`Authorization: Bearer <jwt>`) carrying realm roles and a `tenant_id` claim.
> For local development only, set `AUTH_ENABLED=false` to fall back to
> `x-role` / `x-tenant-id` headers — never do this in production.

> Receiving live Meta webhooks on a locally hosted stack requires a public
> tunnel — see [`docs/runbooks/local-webhook-tunnel.md`](docs/runbooks/local-webhook-tunnel.md).

5. Follow full onboarding and validation runbook:

- [`docs/runbooks/whatsapp-marketing-number-onboarding.md`](docs/runbooks/whatsapp-marketing-number-onboarding.md)
- Optional helper scripts:
  - `scripts/bootstrap-marketing-number.sh`
  - `scripts/local-runbook-e2e.sh`

## Important limitations

- The core platform (auth + persistence + durable RabbitMQ eventing + WhatsApp
  marketing dispatch + inbound/status persistence) is implemented with unit and
  DB integration tests. A full live round-trip still requires a running stack
  (PostgreSQL, Keycloak, RabbitMQ) and real Meta WABA credentials.
- Campaign dispatch is **asynchronous**: `POST /campaigns/:id/dispatch` returns
  `202 Accepted`; the send happens via the outbox relay → RabbitMQ →
  message-worker, and outcomes arrive via status webhooks.
- For production infra (Vault server mode, Keycloak `start`, OpenSearch security,
  Postgres HA, WAF) use `docker-compose.prod.yml` + the runbooks under
  `docs/runbooks/`. True multi-node HA is environment-specific.
- The `scripts/local-runbook-e2e.sh` helper runs with `AUTH_ENABLED=false`
  (header identity); for production use a Keycloak bearer token
  (see `docs/runbooks/keycloak-production.md`).

## Documentation

- [Architecture](docs/architecture.md)
- [Security and Compliance Controls](docs/security/compliance-controls.md)
- [WhatsApp Marketing Number Runbook](docs/runbooks/whatsapp-marketing-number-onboarding.md)
- [Local Webhook Tunnel Runbook](docs/runbooks/local-webhook-tunnel.md)
- [Implementation Roadmap](docs/implementation-roadmap.md)
- [Test Plan and Go-Live Gates](docs/test-plan-and-gates.md)
- [Operational Hardening Gaps](docs/operational-gaps-and-next-hardening.md)

## Automation Helper

- `scripts/bootstrap-marketing-number.sh` bootstraps WABA subscribe/register/channel attach flow for a tenant.
- `scripts/local-runbook-e2e.sh` runs local startup, tenant onboarding, WhatsApp onboarding, campaign dispatch, and validations.
