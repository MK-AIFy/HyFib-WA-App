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
- `/api/v1/conversations`
- `/api/v1/orders`
- `/api/v1/analytics`
- `/api/v1/audit`
- `GET/POST /api/v1/webhooks/meta/whatsapp`

Web entrypoint:

- `/` via `web-portal` (proxied by `edge-proxy`)

## Quick start

1. Copy configuration:

```bash
cp .env.example .env
```

2. Build and run:

```bash
docker compose up --build -d
docker compose ps
```

3. Check health:

```bash
curl http://localhost:18080/health
curl http://localhost:3001/health
curl -A "Mozilla/5.0" http://localhost/health
```

4. Open the web app:

```bash
open http://localhost
```

5. Follow full onboarding and validation runbook:

- [`docs/runbooks/whatsapp-marketing-number-onboarding.md`](docs/runbooks/whatsapp-marketing-number-onboarding.md)
- Optional helper scripts:
  - `scripts/bootstrap-marketing-number.sh`
  - `scripts/local-runbook-e2e.sh`

## Important limitations

- This repo provides a production-ready foundation and contracts, not a complete finished business workflow for every vertical.
- Database HA topology in Compose is reference-oriented for lab/staging and must be hardened for your real on-prem environment.
- Integrations (Meta, Keycloak, Vault, SIEM, SMTP, payment providers) require environment-specific credentials and network controls.

## Documentation

- [Architecture](docs/architecture.md)
- [Security and Compliance Controls](docs/security/compliance-controls.md)
- [WhatsApp Marketing Number Runbook](docs/runbooks/whatsapp-marketing-number-onboarding.md)
- [Implementation Roadmap](docs/implementation-roadmap.md)
- [Test Plan and Go-Live Gates](docs/test-plan-and-gates.md)
- [Operational Hardening Gaps](docs/operational-gaps-and-next-hardening.md)

## Automation Helper

- `scripts/bootstrap-marketing-number.sh` bootstraps WABA subscribe/register/channel attach flow for a tenant.
- `scripts/local-runbook-e2e.sh` runs local startup, tenant onboarding, WhatsApp onboarding, campaign dispatch, and validations.
