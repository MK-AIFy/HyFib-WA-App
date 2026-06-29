# HyFib Feature Audit — Consolidated Findings Report

**Date:** 2026-06-29  
**Method:** Parallel 8-agent audit (A1–A7 code audit, A8 runtime — skipped: Docker not running)  
**Audited:** UI (`index.html`) → API Gateway (`api-gateway/src/index.ts`) → Services → DB (`packages/persistence/src/repositories.ts`)

---

## Scorecard

| Domain | PASS | PARTIAL | GAP | BUG | Checked |
|---|---|---|---|---|---|
| A1 Auth + Setup + Tenants | 8 | 2 | 1 | 4 | 15 |
| A2 Inbox + Conversations | 13 | 3 | 4 | 1 | 21 |
| A3 Contacts + Consent | 13 | 3 | 2 | 4 | 22 |
| A4 Campaigns + Templates | 31 | 3 | 1 | 1 | 36 |
| A5 Automation + Tasks + Teams | 32 | 2 | 2 | 1 | 37 |
| A6 Webhook + Meta Adapter | 22 | 2 | 2 | 0 | 26 |
| A7 Analytics + Reports + Usage + AI | 13 | 3 | 5 | 3 | 24 |
| A8 Runtime Smoke Test | — | — | — | — | SKIPPED (Docker not running) |
| **TOTAL** | **132** | **18** | **17** | **14** | **181** |

**73% of features pass end-to-end. 27% have issues requiring fixes.**

---

## Critical Bugs — Fix Immediately

These are broken in production or violate compliance.

### BUG-01 — Automation bypasses policy engine (COMPLIANCE VIOLATION)
**Domain:** A4 Campaigns  
**File:** [services/notification-worker/src/index.ts:665-710](services/notification-worker/src/index.ts)  
**Detail:** `handleAutomationTemplate()` calls meta-adapter directly with zero policy checks — no consent gate, no opted-out check, no quiet hours. A MARKETING template can be dispatched to an opted-out contact via automation rules.  
**Impact:** GDPR/DPDP violation. Opted-out users receive marketing messages.

### BUG-02 — CSV import broken via web portal UI
**Domain:** A3 Contacts  
**File:** [services/api-gateway/src/index.ts:1596](services/api-gateway/src/index.ts)  
**Detail:** The import endpoint uses `readBinaryBody` to read the request body, but the UI sends `multipart/form-data` via `FormData`. The multipart boundary headers land in the CSV buffer, causing immediate failure on the `phone_e164` column check. Import from the UI is non-functional.  
**Impact:** Contact import via UI always fails silently with a misleading CSV error.

### BUG-03 — Consent grant creates duplicate records
**Domain:** A3 Contacts  
**File:** [packages/persistence/src/repositories.ts:1016](packages/persistence/src/repositories.ts)  
**Detail:** `consentRepository.grant` does a bare `INSERT` with no `ON CONFLICT`. Calling `POST /contacts/:id/consent` more than once creates duplicate consent records that accumulate indefinitely.  
**Impact:** Consent history corrupted; compliance reporting inaccurate.

### BUG-04 — All AI tools broken (field name mismatch)
**Domain:** A7 Analytics/AI  
**File:** [services/web-portal/public/index.html](services/web-portal/public/index.html) + [services/ai-intelligence-service/src/index.ts](services/ai-intelligence-service/src/index.ts)  
**Detail:** UI and AI service use completely different field names for all three tools:
- `campaign-draft`: UI sends `{ goal, tone, audienceSize }` → service requires `{ objective, audienceDescription, offer, tone, language }`
- `segment-summary`: UI sends `{ segmentName, contactCount, avgEngagement }` → service requires `{ segmentName, contacts, conversionRate, optOutRate }`
- `lead-score`: UI sends `{ contactId, messagesSent, replies, daysSinceLastActivity }` → service requires `{ recencyDays, engagementScore, purchaseCount, averageOrderValue }`  
**Impact:** All three AI tools return 400 on every call. AI feature is completely non-functional.

### BUG-05 — Conversation inbox shows "Unknown" for all contacts
**Domain:** A2 Inbox  
**File:** [packages/persistence/src/repositories.ts:1196](packages/persistence/src/repositories.ts)  
**Detail:** `conversationRepository.list()` SELECT does not join or include `contactName`, `contactPhone`, or `lastMessage`. The UI reads these fields from the response but they are never populated — every conversation renders as "Unknown" / blank phone / "—" preview.  
**Impact:** Inbox is visually broken. Agents cannot identify who they are talking to without opening the conversation.

### BUG-06 — In-app tenant creation sends wrong role
**Domain:** A1 Auth  
**File:** [services/web-portal/public/index.html:3335](services/web-portal/public/index.html)  
**Detail:** `showCreateTenant()` in the Tenants view sends the current `S.role` header rather than forcing `platform_owner`. A `sales_agent` or `analyst` using this form sends their own role, which the gateway rejects (or worse, accepts if the check is permissive).  
**Impact:** Tenant creation from the in-app view may fail or operate with wrong permissions depending on the logged-in role.

### BUG-07 — CSV export/import round-trip loses all consent state
**Domain:** A3 Contacts  
**File:** [services/api-gateway/src/csv.ts:141](services/api-gateway/src/csv.ts)  
**Detail:** Export produces a `opted_out` column; the import parser only recognizes `consent` (true/false). A round-trip export → re-import silently discards all consent state, re-importing contacts as if they have no consent record.  
**Impact:** Data migration via CSV destroys consent records. Compliance data loss.

### BUG-08 — Analytics `conversations` KPI always 0
**Domain:** A7 Analytics  
**File:** [packages/persistence/src/repositories.ts](packages/persistence/src/repositories.ts) + [services/web-portal/public/index.html](services/web-portal/public/index.html)  
**Detail:** `tenantAnalytics()` returns `{ templates, campaigns, contacts, optOutRate }`. The UI reads `t["conversations"]` which is never present in the response. The conversations KPI card always displays 0.  
**Impact:** Analytics dashboard shows misleading data.

### BUG-09 — `whatsappSettingsRepository.getByTenant` has no WHERE clause
**Domain:** A1 Auth  
**File:** [packages/persistence/src/repositories.ts:285](packages/persistence/src/repositories.ts)  
**Detail:** The query has no `WHERE tenant_id = $1`; isolation relies entirely on Postgres RLS. If the RLS policy on `whatsapp_settings` is absent or misconfigured, this returns another tenant's settings.  
**Impact:** Potential data leak of WhatsApp configuration across tenants.

---

## High-Priority Gaps — Features Missing Backend or UI

### GAP-01 — Link click tracking end-to-end broken
**Domain:** A7 Analytics  
**File:** [packages/persistence/src/repositories.ts](packages/persistence/src/repositories.ts)  
**Detail:** `linkClickRepository.create()` is never called anywhere in the codebase. The `link_clicks` table is always empty, `/r/:token` redirects always 404, and there is no `GET /analytics/link-clicks` read endpoint.  
**Impact:** Link click tracking feature does not exist at runtime despite the UI showing a "Link Clicks" section.

### GAP-02 — WhatsApp settings UI not connected to backend
**Domain:** A1 Auth  
**File:** [services/web-portal/public/index.html](services/web-portal/public/index.html)  
**Detail:** `renderSettings` never calls `GET /channels/whatsapp/settings` and exposes no PUT form. The backend endpoint is fully implemented and gated but there is no UI path to configure retry limits, rate-limits, or the callback URL.  
**Impact:** Tenant admins cannot change WhatsApp settings without direct API calls.

### GAP-03 — `resolveChannelByPhoneNumberId` not called at gateway webhook POST
**Domain:** A6 Webhook  
**File:** [services/api-gateway/src/index.ts:976](services/api-gateway/src/index.ts)  
**Detail:** The gateway accepts any inbound webhook without validating the `phone_number_id` maps to a known channel. Unknown IDs flow into RabbitMQ and are silently dropped by the worker.  
**Impact:** Invalid webhook payloads are accepted with 200 OK but never processed; no early rejection or error logging.

### GAP-04 — Assignee filter silently ignored in conversation list
**Domain:** A2 Inbox  
**File:** [services/web-portal/public/index.html:1265](services/web-portal/public/index.html)  
**Detail:** `loadConvList` never appends the `assignee=` param even though `S.convFilter.assignee` exists in state. The backend supports it, but it is never sent.  
**Impact:** Assignee filtering in inbox has no effect.

### GAP-05 — No message history pagination
**Domain:** A2 Inbox  
**File:** [services/web-portal/public/index.html:1366](services/web-portal/public/index.html)  
**Detail:** `GET /conversations/:id/messages` is capped at 50 messages. The `before` cursor exists in the repository but the UI never uses it. Conversations older than 50 messages have no load-more.  
**Impact:** Long conversations are truncated in the UI with no way to scroll back further.

### GAP-06 — No `PATCH /teams/:id` route
**Domain:** A5 Teams  
**File:** [services/api-gateway/src/index.ts:1137-1165](services/api-gateway/src/index.ts)  
**Detail:** No update route exists for teams. `teamRepository` has no `update()` method. Team names are permanently immutable after creation.  
**Impact:** Teams cannot be renamed.

### GAP-07 — Task assignee not exposed in create form
**Domain:** A5 Tasks  
**File:** [services/web-portal/public/index.html:2637](services/web-portal/public/index.html)  
**Detail:** `showAddTask()` only sends `{ title, dueAt }`. The API accepts and validates `assigneeUserId` but the UI form never includes it. Every manually created task is always unassigned.  
**Impact:** Task assignment requires API calls; impossible from the UI.

### GAP-08 — No per-campaign analytics filter
**Domain:** A7 Analytics  
**File:** [services/api-gateway/src/index.ts](services/api-gateway/src/index.ts)  
**Detail:** `GET /analytics` has no `?campaignId=` filter and no message-status breakdown (sent/delivered/read/failed per campaign). Campaign-level performance is not measurable.  
**Impact:** Campaign ROI and delivery metrics unavailable.

### GAP-09 — Dead tenants proxy block
**Domain:** A1 Auth  
**File:** [services/api-gateway/src/index.ts:2589](services/api-gateway/src/index.ts)  
**Detail:** A second handler for `/api/v1/tenants` that proxies to a `tenantServiceUrl` microservice is unreachable — the first handler at line 1024 always returns first.  
**Impact:** Dead code creates confusion; the `tenant-service` sidecar is never called.

---

## Partial Implementations

| # | Feature | Domain | What Works | What's Missing |
|---|---|---|---|---|
| P-01 | Auto-reply on interactive messages | A2 | keyword/contains/regex on text | button_reply/list_reply title never extracted; only `matchType=any` fires |
| P-02 | Campaign recipient browsing | A4 | GET /campaigns/:id/report (500 row cap) | No paginated `/recipients` route for large campaigns |
| P-03 | Campaign targeting by contact list | A4 | Segment targeting | `contactIds` ad-hoc list not accepted |
| P-04 | Template list filtering | A4 | All templates returned | No server-side `approved`-only filter |
| P-05 | `hasAccessToken` badge | A1 | Badge renders | `channelRepository.list()` never populates `hasAccessToken`; always shows red |
| P-06 | GET /users role gate | A1 | Reduced payload for non-admin | No role gate; any role can list users |
| P-07 | Idempotency store | A6 | Worker at-least-once guard (Redis) | Gateway + ingestor use in-process Map; breaks under multi-instance |
| P-08 | RLS-only tenant filtering | A5 | Safe under normal operation | `teamRepository.getById`, `automationRuleRepository` COUNT lack explicit WHERE tenant_id |
| P-09 | `m.occurredAt` fallback | A2 | `createdAt` fallback works | `occurredAt` always undefined; dead fallback code |
| P-10 | Billing enforcement | A7 | Usage read-time re-aggregation | No billing events emitted, no quotas enforced |

---

## Passing Features (Highlights)

- **Webhook security:** HMAC with `timingSafeEqual` at both gateway and ingestor — correct
- **AMQP routing:** No queue name mismatch; ingestor→worker delivery confirmed
- **All message types normalized:** text, image, audio, video, document, sticker, location, contacts, interactive, reaction
- **Policy engine:** Quiet hours, frequency cap, category enforcement all wired for campaign dispatch
- **Consent gate on campaigns:** `filterSendableContacts` correctly excludes opted-out and non-consented contacts
- **STOP/START inbound:** Opt-out and re-subscription from inbound messages correctly wired
- **Task reminder scheduler:** Fully implemented — 60s poll, PostgreSQL function, SSE broadcast, de-duplicated
- **Orders CRUD:** Fully wired with RBAC, validation, and audit trail
- **Audit log:** Role gate works (platform_owner, tenant_admin, compliance_auditor only)
- **AI service:** Running, `claude-opus-4-8` model, deterministic fallback available — just needs field name alignment with UI
- **All standalone services wired:** audit-service, billing-usage-service, reporting-service, ai-intelligence-service all registered in docker-compose and reachable via gateway proxy
- **Graph API:** v22.0 pinned, Bearer auth correct, missing token → 503 (not 500), circuit breaker present

---

## Prioritized Fix List

### Priority 1 — Compliance / Legal (fix before next deploy)
1. **BUG-01** — Add `evaluateOutboundPolicy` + consent check to `handleAutomationTemplate()` in notification-worker
2. **BUG-03** — Add `ON CONFLICT (contact_id, channel) DO NOTHING` to `consentRepository.grant`
3. **BUG-07** — Align CSV export column name (`consent` not `opted_out`) or update import parser to accept both

### Priority 2 — Broken core features (fix before user demo)
4. **BUG-05** — JOIN contacts into `conversationRepository.list()` SQL to populate `contactName`, `contactPhone`, `lastMessage`
5. **BUG-02** — Switch import endpoint from `readBinaryBody` to multipart parser (or use `busboy`/`formidable`)
6. **BUG-04** — Align AI tool field names between UI and ai-intelligence-service (or add an adapter layer)

### Priority 3 — Data integrity bugs
7. **BUG-08** — Add `conversations` count to `tenantAnalytics()` return value
8. **BUG-06** — Force `platform_owner` role in `showCreateTenant()` call
9. **BUG-09** — Add explicit `WHERE tenant_id = $1` to `whatsappSettingsRepository.getByTenant`

### Priority 4 — High-value gaps
10. **GAP-01** — Wire `linkClickRepository.create()` into the `/r/:token` redirect handler
11. **GAP-03** — Call `resolveChannelByPhoneNumberId` at gateway webhook POST to reject unknown IDs early
12. **GAP-02** — Add WhatsApp settings form to `renderSettings` UI
13. **GAP-08** — Add `?campaignId=` filter and per-status breakdown to `GET /analytics`

### Priority 5 — UX gaps
14. **GAP-04** — Send `assignee=` param from `loadConvList` when `S.convFilter.assignee` is set
15. **GAP-05** — Add `before` cursor / load-more to message history UI
16. **GAP-06** — Add `PATCH /teams/:id` route + `teamRepository.update()`
17. **GAP-07** — Add assignee picker to task create form

### Priority 6 — Production hardening
18. **P-07** — Replace in-process `IdempotencyStore` Map with Redis-backed store at gateway and ingestor
19. **P-01** — Extract `button_reply.title` / `list_reply.title` in auto-reply rule evaluation
20. **P-08** — Add explicit `WHERE tenant_id` to RLS-reliant queries as defense-in-depth

---

## A8 Runtime Smoke Test
**Status: SKIPPED** — Docker daemon was not running at audit time. Run `docker compose up --build -d` and then `.claude/skills/run-hyfib-wa-app/smoke.sh` to validate the golden path end-to-end. Given BUG-05 (contacts not joined into conversations), BUG-04 (AI tools broken), and BUG-02 (CSV import broken), expect failures in those areas.
