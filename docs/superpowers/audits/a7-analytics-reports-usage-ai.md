# A7 Findings: Analytics + Reports + Usage + AI

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Analytics KPIs — GET /analytics | BUG | UI renders `conversations` from `totals` but `tenantAnalytics()` returns only `templates`, `campaigns`, `contacts`, `optOutRate` — `conversations` is always `0` | `packages/persistence/src/repositories.ts:1607`, `services/web-portal/public/index.html:2908` |
| Analytics by campaignId filter | GAP | No `?campaignId=` filter on `/analytics`; gateway calls `tenantAnalytics(tenantId)` without any filtering | `services/api-gateway/src/index.ts:2536` |
| Analytics funnel / sent/delivered/read/failed counts | GAP | `tenantAnalytics()` returns no message-status breakdown (sent/delivered/read/failed); analytics KPIs are counts of entity records only | `packages/persistence/src/repositories.ts:1607` |
| Link click tracking — GET /analytics/link-clicks | GAP | No `/analytics/link-clicks` read endpoint exists; `linkClickRepository.create()` is never called anywhere in production code paths (no campaign dispatch wires it); only `recordClick` is called (on redirect `/r/:token`) | `packages/persistence/src/repositories.ts:2325`, `services/api-gateway/src/index.ts:947` |
| Link click redirect — GET /r/:token | PASS | Wired at `api-gateway` `/r/:token`; calls `linkClickRepository.recordClick(token)` and redirects to destination | `services/api-gateway/src/index.ts:944` |
| Audit log — GET /audit | PASS | Route exists, RBAC gate enforced (`platform_owner`, `tenant_admin`, `compliance_auditor`), paginated via `parseListQuery` (limit 50, max 200) | `services/api-gateway/src/index.ts:2542` |
| Audit log — dual-write architecture | PARTIAL | Gateway calls `auditRepository.add()` directly via `withTenant` (RLS-safe); `audit-service` separately consumes `AuditEventRecorded` queue topic and writes via `withAdmin` (no per-tenant RLS context on queue-driven writes, but `tenant_id` column is set explicitly) | `services/audit-service/src/index.ts:27`, `packages/persistence/src/repositories.ts:1132` |
| Audit — `marketing_manager` role access | GAP | `marketing_manager` and `support_agent` roles cannot read the audit log (gate only allows `platform_owner`, `tenant_admin`, `compliance_auditor`) — may be intentional but undocumented | `services/api-gateway/src/index.ts:2543` |
| Billing/Usage — GET /usage | PASS | Gateway proxies to `billing-usage-service`; service queries `messages` table grouped by `direction` and `category` per day; RLS applied via `withTenant`; supports 1–90 day window | `services/billing-usage-service/src/index.ts:52`, `services/api-gateway/src/index.ts:2570` |
| Billing/Usage — write-side tracking | GAP | Usage is computed from the `messages` table on read; there is no billing event emitted on campaign dispatch or message send; no per-message billing counter/ledger | `services/billing-usage-service/src/index.ts:66` |
| Reports — GET /reports/overview | PASS | Gateway proxies to `reporting-service`; returns 7 KPIs + last-14-days daily breakdown; RLS applied via `withTenant`; UI fields `conversations`, `contacts`, `templates`, `campaigns`, `messagesInbound`, `messagesOutbound`, `messagesFailed` all match response shape | `services/reporting-service/src/index.ts:46`, `services/api-gateway/src/index.ts:2555` |
| AI — GET/POST /ai/campaign-draft | BUG | UI sends `{ goal, tone, audienceSize }` but `ai-intelligence-service` requires `{ objective, audienceDescription, offer, tone, language }` — validation rejects missing required fields with HTTP 400 | `services/web-portal/public/index.html:3238`, `services/ai-intelligence-service/src/index.ts:171` |
| AI — POST /ai/segment-summary | BUG | UI sends `{ segmentName, contactCount, avgEngagement }` but service requires `{ segmentName, contacts, conversionRate, optOutRate }` — `contacts` (number) is missing so service returns HTTP 400 | `services/web-portal/public/index.html:3254`, `services/ai-intelligence-service/src/index.ts:210` |
| AI — POST /ai/lead-score | BUG | UI sends `{ contactId, messagesSent, replies, daysSinceLastActivity }` but service requires `{ recencyDays, engagementScore, purchaseCount, averageOrderValue }` — all required fields are missing/misnamed, service will use `NaN` values for all inputs | `services/web-portal/public/index.html:3271`, `services/ai-intelligence-service/src/index.ts:245` |
| AI — Claude model ID | PASS | Model resolved from `config.anthropicModel` defaulting to `claude-opus-4-8`; configurable via `ANTHROPIC_MODEL` env var | `packages/config/src/index.ts:204` |
| AI — gateway proxy | PASS | Gateway proxies to `ai-intelligence-service` via HTTP with `x-internal-secret` auth; allowed paths: `campaign-draft`, `segment-summary`, `lead-score`; 90-second timeout | `services/api-gateway/src/index.ts:2625` |
| AI — deterministic fallback | PASS | `aiDeterministicFallback` flag enables local fallback for all three AI endpoints when Claude is unavailable | `services/ai-intelligence-service/src/index.ts:109` |
| Orders — GET /orders | PASS | Route exists, returns all tenant orders via `orderRepository.list(tenantId)` (RLS-safe) | `services/api-gateway/src/index.ts:2489` |
| Orders — POST /orders | PASS | RBAC gate enforced via `canCreateOrder` (`platform_owner`, `tenant_admin`, `marketing_manager`, `support_agent`); full input validation; audit event emitted | `services/api-gateway/src/index.ts:2494` |
| orderRepository — SQL/RLS | PASS | `orderRepository.create()` and `list()` both use `withTenant` (RLS enforced); INSERT includes `tenant_id` | `packages/persistence/src/repositories.ts:1082` |
| audit-service — standalone HTTP service | PASS (limited) | Exposes only `/health` and `/metrics`; no API routes; consumes `AuditEventRecorded` from RabbitMQ queue and writes to `audit_events` via `withAdmin` | `services/audit-service/src/index.ts:37` |
| billing-usage-service — docker-compose | PASS | Defined, `depends_on: postgres-primary`, `app-net` + `data-net` networks, `env_file` | `docker-compose.yml:409` |
| reporting-service — docker-compose | PASS | Defined, `depends_on: postgres-primary`, `app-net` + `data-net` networks, `env_file` | `docker-compose.yml:423` |
| audit-service — docker-compose | PASS | Defined, `depends_on: postgres-primary + rabbitmq`, `app-net` + `data-net`, `env_file` | `docker-compose.yml:383` |
| ai-intelligence-service — docker-compose | PARTIAL | Defined, `app-net` + `data-net` networks, `env_file`; no `depends_on` (safe — no DB required); no health-check defined | `docker-compose.yml:372` |
| All 4 services — gateway depends_on | PASS | `api-gateway.depends_on` includes all four: `audit-service`, `billing-usage-service`, `reporting-service`, `ai-intelligence-service` | `docker-compose.yml:312` |
| Reporting SQL — RLS | PASS | Uses `withTenant` which calls `set_config('app.tenant_id', tenantId, true)`; subqueries inherit the session-local config so RLS policies are applied | `services/reporting-service/src/index.ts:52`, `packages/db/src/index.ts:70` |
| Reporting SQL — no explicit time-range on entity counts | PARTIAL | `conversations`, `contacts`, `templates`, `campaigns` counts are all-time (no date filter); only `messages` daily rows have a 14-day window — this is by design for a summary report but may surprise users expecting current-period-only data | `services/reporting-service/src/index.ts:54` |

---

## Issues (GAP / PARTIAL / BUG only)

### Analytics KPIs: `conversations` always 0 — BUG
**File:** `packages/persistence/src/repositories.ts:1607`, `services/web-portal/public/index.html:2908`
**Detail:** The UI renders four KPI cards: `contacts`, `templates`, `campaigns`, `conversations`. The `tenantAnalytics()` function returns `{ templates, campaigns, contacts, optOutRate }` — there is no `conversations` field. The UI reads `t["conversations"] || 0` which always evaluates to `0`.
**Impact:** The Conversations KPI in the Analytics view is permanently zeroed. Users see misleading data.

### Analytics: no campaign-scoped filtering — GAP
**File:** `services/api-gateway/src/index.ts:2536`
**Detail:** `GET /analytics` has no query-param filtering. There is no `?campaignId=` branch. Campaign-level analytics (sent/delivered/read rates) do not exist in this endpoint.
**Impact:** Per-campaign performance tracking is unavailable via the analytics API.

### Analytics: no message-status KPIs (sent/delivered/read/failed) — GAP
**File:** `packages/persistence/src/repositories.ts:1607`
**Detail:** `tenantAnalytics()` queries `templates`, `campaigns`, and `contacts` tables only. It does not query `messages` for status counts. Fields expected by a typical WhatsApp KPI dashboard (sent, delivered, read, failed) are absent.
**Impact:** Core messaging funnel metrics are missing from the analytics endpoint.

### Link click tracking: `linkClickRepository.create()` never called — GAP
**File:** `packages/persistence/src/repositories.ts:2325`, `services/api-gateway/src/index.ts:947`
**Detail:** `linkClickRepository.create()` (which seeds a link token into `link_clicks`) is imported in the gateway but never called in any campaign dispatch or message-send flow. `linkClickRepository.recordClick()` is called on `/r/:token` redirect — but tokens can only exist if `create()` was called first. Since `create()` is a dead code path, the `link_clicks` table is always empty and the redirect will always return 404.
**Impact:** Click-through tracking is completely non-functional end-to-end. No tracking data is collected.

### No `GET /analytics/link-clicks` endpoint — GAP
**File:** `services/api-gateway/src/index.ts` (absent)
**Detail:** There is no API route exposing aggregated link click data. Even if the `link_clicks` table had data, there is no read endpoint for it.
**Impact:** Link click analytics are not queryable.

### AI campaign-draft: field name mismatch between UI and service — BUG
**File:** `services/web-portal/public/index.html:3238`, `services/ai-intelligence-service/src/index.ts:171`
**Detail:** UI submits `{ goal, tone, audienceSize }`. Service validates and requires `{ objective, audienceDescription, offer, tone, language }`. None of the required fields (`objective`, `audienceDescription`, `offer`, `language`) are sent by the UI. Service returns HTTP 400 on every call.
**Impact:** Campaign Draft AI tool is completely broken for all users.

### AI segment-summary: field name mismatch — BUG
**File:** `services/web-portal/public/index.html:3254`, `services/ai-intelligence-service/src/index.ts:210`
**Detail:** UI sends `{ segmentName, contactCount, avgEngagement }`. Service requires `{ segmentName, contacts, conversionRate, optOutRate }` where `contacts` must be a positive number. Since `contacts` is not sent, validation fails with HTTP 400 on every call.
**Impact:** Segment Summary AI tool is completely broken for all users.

### AI lead-score: all fields misnamed — BUG
**File:** `services/web-portal/public/index.html:3271`, `services/ai-intelligence-service/src/index.ts:245`
**Detail:** UI sends `{ contactId, messagesSent, replies, daysSinceLastActivity }`. Service expects `{ recencyDays, engagementScore, purchaseCount, averageOrderValue }` and runs `Number()` on each. All four fields arrive as `undefined` → `NaN`. While the fallback scoring function (`fallbackLeadScore`) may still run (NaN checks pass after `Number.isFinite` guards raise a 400), the score is always wrong.
**Impact:** Lead Score AI tool returns HTTP 400 for all inputs; score is never computed from real UI-supplied values.

### Billing/Usage: no write-side billing events — GAP
**File:** `services/billing-usage-service/src/index.ts:66`
**Detail:** Usage is computed at query time from the `messages` table (group by `direction`, `category`). No billing ledger, no per-dispatch event, no cost-per-message counter is emitted during campaign send or inbound webhook processing. This means: (a) the usage view is a lagging re-aggregation of raw message rows; (b) there is no mechanism for per-message billing caps, quota enforcement, or overage alerting.
**Impact:** No billing enforcement mechanism exists. Usage reporting only works retrospectively from raw message data.

### ai-intelligence-service: no health-check in docker-compose — PARTIAL
**File:** `docker-compose.yml:372`
**Detail:** Unlike `api-gateway` which has a `healthcheck` block, `ai-intelligence-service` has none. Docker's `depends_on` will mark it ready immediately at container start rather than waiting for the HTTP server to be healthy. Under slow startup, the gateway may attempt AI proxy calls before the service is ready.
**Impact:** Cold-start race condition possible for AI endpoints; likely masked by retries but not reliable.
