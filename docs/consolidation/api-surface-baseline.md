# External API Surface — Baseline (pre-consolidation)

Captured from `services/api-gateway/src/index.ts` at tag `pre-consolidation`.
This is the byte-for-byte contract the modular monolith (`services/app-server`) must preserve.
Used as the Phase-9 cutover diff (run each against the live app-server).

## Infra / edge
- `GET /metrics`
- `GET /health`
- `GET /r/*` (short-link redirect)

## Webhooks (unauthenticated, Meta)
- `GET  /api/v1/webhooks/meta/whatsapp` (verify challenge)
- `POST /api/v1/webhooks/meta/whatsapp` (inbound) → proxies to webhook-ingestor

## Auth (unauthenticated)
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET  /auth/me`

## Tenants
- `/api/v1/tenants` (GET list / POST create)
- `PATCH /api/v1/tenants/{id}`
- `GET   /api/v1/tenants/{id}/users`

## Realtime
- `GET /api/v1/events/stream` (SSE, fetch-streamed with Bearer header)

## Users / Teams
- `/api/v1/users` (GET / POST)
- `POST  /api/v1/users/{id}/set-password`
- `PATCH /api/v1/users/{id}`
- `/api/v1/teams` (GET / POST)
- `/api/v1/teams/{id}/members` (GET / POST / DELETE)

## WhatsApp channel
- `/api/v1/channels/whatsapp` (GET / POST)
- `/api/v1/channels/whatsapp/settings`
- `POST /api/v1/channels/whatsapp/{id}/sync-templates` → proxies to meta-adapter (templates)
- `POST /api/v1/channels/whatsapp/{id}/media` → proxies to meta-adapter (media upload)

## Templates / Segments / Contacts / Tags
- `/api/v1/templates` (GET)
- `/api/v1/segments` (GET / POST)
- `GET /api/v1/segments/{id}/preview`
- `/api/v1/contacts` (GET / POST)
- `GET  /api/v1/contacts/export`
- `POST /api/v1/contacts/import`
- `POST /api/v1/contacts/{id}/consent`
- `POST /api/v1/contacts/{id}/opt-out`
- `/api/v1/contacts/{id}/notes`
- `/api/v1/contacts/{id}/tags`
- `PATCH /api/v1/contacts/{id}/fields`
- `GET  /api/v1/contacts/{id}`
- `/api/v1/tags` (GET / POST)

## Campaigns
- `/api/v1/campaigns` (GET / POST)
- `POST /api/v1/campaigns/{id}/dispatch`
- `POST /api/v1/campaigns/{id}/run`
- `GET  /api/v1/campaigns/{id}/report`

## Conversations / Messages
- `GET  /api/v1/conversations`
- `POST /api/v1/conversations/{id}/assign`
- `POST /api/v1/conversations/{id}/assign-team`
- `POST /api/v1/conversations/{id}/state`
- `/api/v1/conversations/{id}/notes`
- `/api/v1/conversations/{id}/messages` (GET history / POST send)

## Automation / Saved replies / Tasks / Orders
- `/api/v1/auto-reply-rules` (GET / POST) + `PATCH /api/v1/auto-reply-rules/{id}`
- `/api/v1/saved-replies` (GET / POST) + `DELETE /api/v1/saved-replies/{id}`
- `/api/v1/automation-rules` (GET / POST) + `PATCH /api/v1/automation-rules/{id}`
- `/api/v1/tasks` (GET / POST) + `PATCH /api/v1/tasks/{id}`
- `/api/v1/orders` (GET / POST)

## Analytics / Reports / Usage / AI
- `GET /api/v1/analytics/link-clicks`
- `GET /api/v1/analytics`
- `GET /api/v1/audit`
- `GET /api/v1/reports/overview` → proxies to reporting-service
- `GET /api/v1/usage` → proxies to billing-usage-service
- `/api/v1/ai/*` (GET / POST) → proxies to ai-intelligence-service

## Internal HTTP proxies to be replaced by direct calls
| Gateway call site | Config URL | Internal path | Target service | Phase |
|---|---|---|---|---|
| `index.ts:1121` | `webhookIngestorUrl` | `POST /internal/v1/webhooks/meta/whatsapp` | webhook-ingestor | 3 |
| `index.ts:644` | `metaAdapterUrl` | `GET /internal/v1/whatsapp/templates` | meta-adapter | 4 |
| `index.ts:1770` | `metaAdapterUrl` | `POST /internal/v1/whatsapp/media` | meta-adapter | 4 |
| `index.ts:3018` | `reportingServiceUrl` | `GET /internal/v1/reports/overview` | reporting | 8 |
| `index.ts:3034` | `billingUsageServiceUrl` | `GET /internal/v1/usage` | billing-usage | 7 |
| `index.ts:3059` | `aiIntelligenceUrl` | `POST/GET /internal/v1/ai/*` | ai-intelligence | 6 |

**Note:** the notification-worker consumes events off the bus and calls `metaAdapterUrl` to send; that becomes a direct `metaClient` injection in Phase 5. After Phase 9 all `/internal/v1/*` paths must 404 from the edge.
