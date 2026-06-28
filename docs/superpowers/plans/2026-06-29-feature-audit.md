# Feature Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every feature in the HyFib WhatsApp Business Platform end-to-end (UI → API → Service → DB) and produce a single prioritized findings report.

**Architecture:** Eight agents run in parallel (A1–A7 code audits, A8 runtime smoke test). Each agent reads the relevant UI section of `index.html`, the matching routes in `api-gateway/src/index.ts`, the downstream service files, and the persistence repositories. A ninth consolidation pass merges all agent reports into `docs/superpowers/audits/2026-06-29-feature-audit-findings.md`.

**Tech Stack:** TypeScript ESM monorepo, pnpm workspaces, PostgreSQL (via `@hyfib/persistence`), RabbitMQ (via `@hyfib/queue`), Redis, Docker Compose, vanilla-JS single-page portal (`index.html` + `lib.mjs`).

## Global Constraints

- Never modify source files — this is a read-only audit
- Report findings using exactly four statuses: PASS, GAP, PARTIAL, BUG
- Every finding must cite the file path and line number where the gap/bug exists
- A8 requires Docker daemon running; skip A8 and note it if Docker is unavailable
- Output: one markdown findings file per agent saved to `docs/superpowers/audits/`
- Final consolidated report: `docs/superpowers/audits/2026-06-29-feature-audit-findings.md`

---

## File Map

| Path | Role |
|---|---|
| `services/web-portal/public/index.html` | All UI views (3353 lines) — single source of UI truth |
| `services/web-portal/public/lib.mjs` | Shared UI utilities (esc, fmtTime, pagerHtml, buildQuery) |
| `services/api-gateway/src/index.ts` | All API routes (2704 lines) — gateway monolith |
| `services/api-gateway/src/campaign.ts` | Campaign fan-out + consent filtering |
| `services/api-gateway/src/authorization.ts` | RBAC helpers (canCreateContact, canCreateOrder) |
| `services/api-gateway/src/validation.ts` | Input validation (parseListQuery, validateCampaignBody, etc.) |
| `services/api-gateway/src/sse-hub.ts` | Server-Sent Events hub |
| `services/api-gateway/src/csv.ts` | CSV parse + serialize |
| `packages/persistence/src/repositories.ts` | All DB repositories |
| `packages/persistence/src/db.ts` | Pool setup, withTenant, RLS |
| `packages/auth/src/index.ts` | JWT auth, role normalisation, AuthError |
| `packages/policy-engine/src/index.ts` | evaluateOutboundPolicy (quiet hours, freq cap, category) |
| `packages/queue/src/index.ts` | RabbitMQ publish/consume |
| `packages/event-bus/src/index.ts` | In-process event bus |
| `packages/shared-core/src/index.ts` | Shared types, EventTopics, evaluateAutomationRules |
| `services/notification-worker/src/index.ts` | Campaign dispatch worker (767 lines) |
| `services/notification-worker/src/outbound.ts` | Outbound send logic |
| `services/notification-worker/src/autoreply.ts` | Auto-reply rule execution |
| `services/notification-worker/src/automation.ts` | Automation rule execution |
| `services/notification-worker/src/personalize.ts` | Template variable personalisation |
| `services/webhook-ingestor/src/index.ts` | Inbound webhook ingestion (233 lines) |
| `services/webhook-ingestor/src/normalize.ts` | Webhook payload normalisation |
| `services/meta-adapter/src/index.ts` | WhatsApp Graph API client (739 lines) |
| `services/meta-adapter/src/graph-messages.ts` | Message send helpers |
| `services/ai-intelligence-service/src/index.ts` | AI backoffice service (294 lines) |
| `services/audit-service/src/index.ts` | Audit service |
| `services/billing-usage-service/src/index.ts` | Billing/usage service |
| `services/reporting-service/src/index.ts` | Reporting service |
| `services/campaign-service/src/index.ts` | Campaign service |
| `services/conversation-service/src/index.ts` | Conversation service |
| `.claude/skills/run-hyfib-wa-app/smoke.sh` | End-to-end smoke test driver |
| `docs/superpowers/audits/` | Output directory for per-agent and consolidated reports |

---

### Task 0: Prepare audit output directory

**Files:**
- Create: `docs/superpowers/audits/` (directory)

- [ ] **Step 1: Create the output directory**

```bash
mkdir -p docs/superpowers/audits
```

- [ ] **Step 2: Commit the directory placeholder**

```bash
touch docs/superpowers/audits/.gitkeep
git add docs/superpowers/audits/.gitkeep
git commit -m "chore: create audit output directory"
```

---

### Task 1 (A1): Audit — Auth + Setup + Tenants

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderSetup`, `doStep1`, `doStep2`, `renderTenants`, `renderSettings`, `renderStep1`, `renderStep2`
- `services/api-gateway/src/index.ts` — search for `/tenants`, `/users`, `/channels/whatsapp`, `/whatsapp-settings`, role gates
- `packages/auth/src/index.ts` — full file
- `packages/persistence/src/repositories.ts` — `tenantRepository`, `userRepository`, `channelRepository`, `whatsappSettingsRepository`

**Output:** `docs/superpowers/audits/a1-auth-setup-tenants.md`

**What to check:**

| Feature | UI call | API route | Service | DB |
|---|---|---|---|---|
| Create tenant | `POST /tenants` with `platform_owner` role | Route exists? Body validated? | tenantRepository.create | INSERT tenants |
| Get tenant | `GET /tenants` | Route + RLS | tenantRepository.list | SELECT with tenant filter |
| Existing tenant login (step 1 skip) | GET /channels/whatsapp on existing tid | Route exists? | channelRepository.list | SELECT channels |
| Create user | `POST /users` | Route + role gate | userRepository.create | INSERT users |
| List users | `GET /users` | Route | userRepository.list | SELECT |
| Channel registration | `POST /channels/whatsapp` | Route + body validation | channelRepository.create | INSERT channels |
| Channel settings | `GET/PUT /channels/whatsapp/:id/settings` | Routes exist? | whatsappSettingsRepository | SELECT/UPDATE |
| RBAC: analyst blocked on POST /contacts | 403 response | `canCreateContact` check | authorization.ts | N/A |
| Role switcher in UI | x-role header sent correctly | Role normalised server-side | hasAnyRole | N/A |
| Logout | localStorage cleared | No server call needed | N/A | N/A |

- [ ] **Step 1: Read UI setup + tenant sections**

Search `index.html` for: `renderSetup`, `doStep1`, `doStep2`, `doStep2Skip`, `renderTenants`, `renderSettings`. For each UI call, record: HTTP method, path, headers sent, body shape, error handling present.

- [ ] **Step 2: Read API gateway tenant/user/channel routes**

Search `api-gateway/src/index.ts` for: `POST /tenants`, `GET /tenants`, `POST /users`, `GET /users`, `POST /channels/whatsapp`, `GET /channels/whatsapp`, `PUT /channels/whatsapp`. For each: confirm route exists, auth enforced, role checked, body validated, repository called.

- [ ] **Step 3: Read auth package**

Read `packages/auth/src/index.ts` fully. Check: JWT parsing, role normalization, `hasAnyRole`, `AuthError` thrown correctly, tenant extraction from token vs. header.

- [ ] **Step 4: Read persistence repositories for this domain**

In `packages/persistence/src/repositories.ts` search for `tenantRepository`, `userRepository`, `channelRepository`, `whatsappSettingsRepository`. For each: check SQL correctness, parameterization (no string interpolation), RLS (`withTenant` used where needed).

- [ ] **Step 5: Write findings**

Write `docs/superpowers/audits/a1-auth-setup-tenants.md` using the format:

```markdown
# A1 Findings: Auth + Setup + Tenants

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Create tenant | PASS/GAP/PARTIAL/BUG | one-line reason | path:line |
...

## Issues (GAP / PARTIAL / BUG only)
### [Feature name] — [Status]
**File:** path:line
**Detail:** exact description of what is missing or wrong
**Impact:** what breaks for the user
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/audits/a1-auth-setup-tenants.md
git commit -m "audit: A1 auth+setup+tenants findings"
```

---

### Task 2 (A2): Audit — Inbox + Conversations

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderInbox`, `loadConvList`, `selectConv`, `loadMessages`, `sendMsg`, `assignConv`, `assignConvTeam`, `changeConvState`, `addConvNote`, `showSavedReplies`, `showAutoRules`, `connectSSE`, `onSSE`
- `services/api-gateway/src/index.ts` — search for `/conversations`, `/saved-replies`, `/auto-reply-rules`, `/events/stream`
- `services/api-gateway/src/sse-hub.ts` — full file
- `packages/persistence/src/repositories.ts` — `conversationRepository`, `messageRepository`, `savedReplyRepository`, `autoReplyRuleRepository`, `conversationNoteRepository`
- `services/notification-worker/src/autoreply.ts` — full file

**Output:** `docs/superpowers/audits/a2-inbox-conversations.md`

**What to check:**

| Feature | UI call | API route | Service/Repo | Integration |
|---|---|---|---|---|
| Conversation list | GET /conversations | Route + pagination | conversationRepository.list | Filter by state/assignee |
| Message history | GET /conversations/:id/messages | Route | messageRepository.list | Payload shape (.payload.text) |
| Send text message | POST /conversations/:id/messages {kind:"text"} | Route + body validation | messageRepository.create + outbound enqueue | meta-adapter called? |
| Assign to user | POST /conversations/:id/assign | Route | conversationRepository.assign | SSE event fired? |
| Assign to team | POST /conversations/:id/assign-team | Route | teamRepository + conv update | SSE event fired? |
| Change state | POST /conversations/:id/state | Route | conversationRepository.setState | SSE event fired? |
| Internal notes | GET/POST /conversations/:id/notes | Routes | conversationNoteRepository | Notes not sent to customer |
| Saved replies | GET/POST /saved-replies | Routes | savedReplyRepository | Insert/list correct |
| Auto-reply rules | GET/POST /auto-reply-rules, PATCH | Routes | autoReplyRuleRepository | Worker consumes + fires |
| SSE stream | GET /events/stream | Route | SseHub.subscribe | Tenant-scoped, reconnect on drop |
| SSE inbound push | onSSE handler in UI | SseHub.publish | Event from ingestor→worker→hub | Topic routing correct |

- [ ] **Step 1: Read UI inbox section** — trace all `fetch` calls in `renderInbox`, `loadConvList`, `selectConv`, `loadMessages`, `sendMsg`, `connectSSE`, `onSSE`.
- [ ] **Step 2: Read API conversation + SSE routes** — confirm every UI call has a matching route, check auth, pagination params, body shapes.
- [ ] **Step 3: Read sse-hub.ts** — check: tenant isolation, client registration/cleanup, publish signature, reconnect handling.
- [ ] **Step 4: Read persistence repositories** — `conversationRepository`, `messageRepository`, `savedReplyRepository`, `autoReplyRuleRepository`, `conversationNoteRepository`: SQL correctness, RLS, payload column shape.
- [ ] **Step 5: Read autoreply worker** — does `autoreply.ts` correctly consume inbound messages, evaluate rules, and enqueue replies?
- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a2-inbox-conversations.md` (same table+issues format as A1).
- [ ] **Step 7: Commit** `git commit -m "audit: A2 inbox+conversations findings"`

---

### Task 3 (A3): Audit — Contacts + Consent

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderContacts`, `loadContacts`, `showAddContact`, `showContactProfile`, `grantConsent`, `doOptOut`, `showImportCsv`, `exportContacts`, `onContactSearch`
- `services/api-gateway/src/index.ts` — search for `/contacts`, `/tags`, `/consent`, `/opt-out`, `/import`, `/export`
- `services/api-gateway/src/csv.ts` — full file
- `services/api-gateway/src/authorization.ts` — `canCreateContact`
- `packages/persistence/src/repositories.ts` — `contactRepository`, `consentRepository`, `contactImportRepository`, `contactNoteRepository`, `tagRepository`

**Output:** `docs/superpowers/audits/a3-contacts-consent.md`

**What to check:**

| Feature | UI call | API route | Repo | Notes |
|---|---|---|---|---|
| List contacts | GET /contacts?q=&offset= | Route + pagination | contactRepository.list | Search by name/phone |
| Add contact | POST /contacts | Route + RBAC (analyst=403) | contactRepository.create | canCreateContact enforced? |
| Contact profile | GET /contacts/:id | Route | contactRepository.findById | Tags, notes included? |
| Grant consent | POST /contacts/:id/consent | Route | consentRepository.grant | Idempotent? |
| Opt-out | POST /contacts/:id/opt-out | Route | contactRepository.optOut + consentRepository | optedOut flag set |
| Import CSV | POST /contacts/import (multipart) | Route | contactImportRepository / parseCsv | Required cols validated |
| Export CSV | GET /contacts/export | Route (returns CSV) | serializeContactsCsv | Content-Type correct |
| Contact notes | GET/POST /contacts/:id/notes | Routes | contactNoteRepository | |
| Tags | GET /tags | Route | tagRepository.list | Used in campaign segments? |
| Inbound STOP opt-out | Automatic from webhook | auto-opt-out in worker or gateway | contactRepository.optOut | Triggered from inbound msg? |

- [ ] **Step 1: Read UI contacts section** — trace all fetch calls.
- [ ] **Step 2: Read API contact routes** — every route, RBAC, validation, CSV multipart handling.
- [ ] **Step 3: Read csv.ts** — `parseCsv` validates required `phone_e164` column? `serializeContactsCsv` correct headers?
- [ ] **Step 4: Read persistence** — `contactRepository`, `consentRepository`, `contactImportRepository`, `contactNoteRepository`, `tagRepository`: SQL, RLS, upsert logic for import.
- [ ] **Step 5: Check STOP/START handling** — search notification-worker and gateway for `STOP`/`START` keyword detection → `opt-out` / re-subscribe flow.
- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a3-contacts-consent.md`.
- [ ] **Step 7: Commit** `git commit -m "audit: A3 contacts+consent findings"`

---

### Task 4 (A4): Audit — Campaigns + Templates

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderCampaigns`, `renderTemplates`, `showCreateCampaign`, `dispatchCampaign`, `loadTemplates`, `syncTemplates`
- `services/api-gateway/src/index.ts` — search for `/campaigns`, `/templates`
- `services/api-gateway/src/campaign.ts` — full file (`filterSendableContacts`)
- `services/api-gateway/src/validation.ts` — `validateCampaignBody`
- `packages/policy-engine/src/index.ts` — full file
- `packages/persistence/src/repositories.ts` — `campaignRepository`, `templateRepository`, `campaignRecipientRepository`, `outboxRepository`
- `services/notification-worker/src/index.ts` — consume + dispatch loop
- `services/notification-worker/src/outbound.ts` — send logic
- `services/notification-worker/src/personalize.ts` — variable substitution
- `services/meta-adapter/src/index.ts` — Graph API send

**Output:** `docs/superpowers/audits/a4-campaigns-templates.md`

**What to check:**

| Feature | UI call | API route | Service | Integration |
|---|---|---|---|---|
| List templates | GET /templates | Route | templateRepository.list | Status filter (approved only for dispatch?) |
| Sync templates | POST /templates/sync | Route | meta-adapter → templateRepository.upsert | Access token required |
| Create campaign | POST /campaigns | Route + validateCampaignBody | campaignRepository.create | segmentId or contactIds? |
| List campaigns | GET /campaigns | Route | campaignRepository.list | Status, pagination |
| Campaign recipients | GET /campaigns/:id/recipients | Route | campaignRecipientRepository.list | |
| Dispatch campaign | POST /campaigns/:id/dispatch | Route + consent gate | filterSendableContacts → outboxRepository.enqueue | policy engine called? |
| Policy engine | quiet hours, freq cap, category | evaluateOutboundPolicy | packages/policy-engine | Applied per recipient? |
| Worker consume | amqp consume on dispatch queue | notification-worker | outbound.ts → meta-adapter | Retry on failure? |
| Variable personalisation | {{1}} → contact field | personalize.ts | VariableMapping applied | Fallback for missing vars? |
| Template category protection | MARKETING vs UTILITY | policy engine | category check | Enforced pre-dispatch? |
| Consent gate | contacts must have active consent | filterSendableContacts | consentRepository.hasActiveConsent | Opt-out excluded? |

- [ ] **Step 1: Read UI campaigns + templates** — trace all fetch calls.
- [ ] **Step 2: Read API campaign + template routes** — routes, body validation, consent gate, policy engine call site.
- [ ] **Step 3: Read campaign.ts** — `filterSendableContacts`: does it query consent correctly? Does it exclude opted-out contacts?
- [ ] **Step 4: Read policy-engine** — `evaluateOutboundPolicy`: quiet hours logic, frequency cap query, category enforcement.
- [ ] **Step 5: Read notification-worker** — `index.ts` consumer, `outbound.ts` send, `personalize.ts` substitution. Check: AMQP queue name matches gateway enqueue name, error handling, DLQ configured?
- [ ] **Step 6: Read meta-adapter send path** — `graph-messages.ts`: correct Graph API endpoint, auth header, media vs text vs template send.
- [ ] **Step 7: Write findings** to `docs/superpowers/audits/a4-campaigns-templates.md`.
- [ ] **Step 8: Commit** `git commit -m "audit: A4 campaigns+templates findings"`

---

### Task 5 (A5): Audit — Automation + Tasks + Teams

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderAutomation`, `renderTasks`, `renderTeams`, `showAutoRules`, `toggleRule`
- `services/api-gateway/src/index.ts` — search for `/automation-rules`, `/tasks`, `/teams`
- `packages/persistence/src/repositories.ts` — `automationRuleRepository`, `taskRepository`, `teamRepository`
- `packages/shared-core/src/automation.ts` — `evaluateAutomationRules`
- `services/notification-worker/src/automation.ts` — automation execution

**Output:** `docs/superpowers/audits/a5-automation-tasks-teams.md`

**What to check:**

| Feature | UI call | API route | Repo/Service | Notes |
|---|---|---|---|---|
| Auto-reply rules list | GET /auto-reply-rules | Route | autoReplyRuleRepository.list | |
| Create auto-reply rule | POST /auto-reply-rules | Route + body | autoReplyRuleRepository.create | matchType validated? |
| Toggle rule | PATCH /auto-reply-rules/:id {enabled} | Route | autoReplyRuleRepository.update | |
| Worker fires reply | inbound msg → rule eval | autoreply.ts | autoReplyRuleRepository.findActive → enqueue | Priority ordering? |
| Automation rules list | GET /automation-rules | Route | automationRuleRepository.list | |
| Create automation rule | POST /automation-rules | Route | automationRuleRepository.create | trigger/conditions/actions validated? |
| Evaluate automation | on conversation events | evaluateAutomationRules | shared-core/automation.ts | Trigger types: message_received, state_changed? |
| Task list | GET /tasks | Route | taskRepository.list | |
| Create task | POST /tasks | Route | taskRepository.create | Due date, assignee |
| Update task | PATCH /tasks/:id | Route | taskRepository.update | |
| Task reminder SSE | task.reminder event | SseHub.publish | scheduled check or event | How triggered? cron or event? |
| Team list | GET /teams | Route | teamRepository.list | |
| Create team | POST /teams | Route | teamRepository.create | |
| Team membership | POST /teams/:id/members | Route | teamRepository.addMember | |
| Assign conv to team | POST /conversations/:id/assign-team | Route | conversationRepository.assignTeam | Cross-domain check |

- [ ] **Step 1: Read UI automation + tasks + teams sections** — trace all fetch calls.
- [ ] **Step 2: Read API routes** — automation-rules, tasks, teams: every CRUD route, body shapes, role gates.
- [ ] **Step 3: Read shared-core/automation.ts** — `evaluateAutomationRules`: trigger matching, condition evaluation, action dispatch.
- [ ] **Step 4: Read notification-worker/automation.ts** — does it consume automation events and execute actions (assign, change state, send message)?
- [ ] **Step 5: Check task reminder mechanism** — how does `task.reminder` SSE event get fired? Is there a cron job, a DB trigger, or a worker poll?
- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a5-automation-tasks-teams.md`.
- [ ] **Step 7: Commit** `git commit -m "audit: A5 automation+tasks+teams findings"`

---

### Task 6 (A6): Audit — Webhook + Meta Adapter

**Files to read:**
- `services/api-gateway/src/index.ts` — search for `/webhooks/meta/whatsapp`, `verifyMetaSignature`, `verifyWebhookToken`
- `services/webhook-ingestor/src/index.ts` — full file
- `services/webhook-ingestor/src/normalize.ts` — full file
- `services/meta-adapter/src/index.ts` — full file
- `services/meta-adapter/src/graph-messages.ts` — full file
- `packages/shared-core/src/security.ts` — HMAC verification
- `packages/queue/src/index.ts` — RabbitMQ publish

**Output:** `docs/superpowers/audits/a6-webhook-meta-adapter.md`

**What to check:**

| Feature | Entry point | Service | Integration | Notes |
|---|---|---|---|---|
| Webhook token verify | GET /webhooks/meta/whatsapp?hub.verify_token= | verifyWebhookToken | Env var match | Must return hub.challenge |
| HMAC verification | POST /webhooks/meta/whatsapp X-Hub-Signature-256 | verifyMetaSignature | crypto.timingSafeEqual | Raw body required |
| Inbound message routing | webhook → ingestor → RabbitMQ | normalize.ts | resolveChannelByPhoneNumberId | phone_number_id lookup |
| Message normalisation | raw Graph payload → internal format | normalize.ts | EventEnvelope shape | text/media/interactive/button |
| Idempotency | duplicate wamid | IdempotencyStore | Redis SET NX | Returns duplicate_ignored |
| RabbitMQ publish | after normalisation | queue.publish | exchange + routing key | No mandatory flag — silent drop risk |
| Worker consume inbound | RabbitMQ → notification-worker | worker index.ts | inbound message handling | Conversation created/updated |
| STOP → opt-out | inbound "STOP" text | worker or gateway | contactRepository.optOut | Case-insensitive? |
| START → re-subscribe | inbound "START" text | worker or gateway | consentRepository.grant | |
| Outbound send (meta-adapter) | notification-worker → meta-adapter | graph-messages.ts | Graph API /messages | Auth header, WABA context |
| Media upload | POST /channels/whatsapp/:id/media | meta-adapter | Graph API /media | Returns mediaId for reuse |

- [ ] **Step 1: Read gateway webhook routes** — GET verify + POST ingest: HMAC check sequence, raw body capture, idempotency call site.
- [ ] **Step 2: Read webhook-ingestor** — full `index.ts` + `normalize.ts`: HMAC re-check? RabbitMQ publish params, exchange/queue names, normalization coverage (all message types).
- [ ] **Step 3: Cross-check queue names** — compare `queue.publish(routingKey)` in ingestor vs `queue.consume(queueName)` in notification-worker. Mismatch = silent drop.
- [ ] **Step 4: Read meta-adapter** — `index.ts` + `graph-messages.ts`: Graph API version, auth header format, send text/template/media paths, error handling (503 on missing token?).
- [ ] **Step 5: Check STOP/START handling** — search entire codebase for `STOP` and `START` string handling in inbound path.
- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a6-webhook-meta-adapter.md`.
- [ ] **Step 7: Commit** `git commit -m "audit: A6 webhook+meta-adapter findings"`

---

### Task 7 (A7): Audit — Analytics + Reports + Usage + AI

**Files to read:**
- `services/web-portal/public/index.html` — search for `renderAnalytics`, `renderReports`, `renderUsage`, `renderAI`
- `services/api-gateway/src/index.ts` — search for `/analytics`, `/reports`, `/billing`, `/usage`, `/audit`, `/ai`
- `packages/persistence/src/repositories.ts` — `tenantAnalytics`, `auditRepository`, `linkClickRepository`, `orderRepository`
- `services/ai-intelligence-service/src/index.ts` — full file
- `services/audit-service/src/index.ts` — full file
- `services/billing-usage-service/src/index.ts` — full file
- `services/reporting-service/src/index.ts` — full file

**Output:** `docs/superpowers/audits/a7-analytics-reports-usage-ai.md`

**What to check:**

| Feature | UI call | API route | Service/Repo | Notes |
|---|---|---|---|---|
| Analytics KPIs | GET /analytics | Route | tenantAnalytics | sent/delivered/read/failed counts |
| Analytics by campaign | GET /analytics?campaignId= | Route | tenantAnalytics filter | |
| Funnel display | UI renders funnel bars | Client-side from analytics response | N/A | Field names match? |
| Link click tracking | GET /analytics/link-clicks | Route | linkClickRepository | Tracked on inbound click webhook? |
| Reports | GET /reports | Route | reportingService or persistence | What data? Aggregated? |
| Audit log | GET /audit | Route | auditRepository.list | Pagination, role gate (compliance_auditor) |
| Usage/billing | GET /billing/usage | Route | billingUsageService | Per-tenant, per-period |
| AI tools UI | renderAI | API calls to /ai/* | ai-intelligence-service | What endpoints exposed? |
| AI service routes | /ai/... | Routes in gateway | ai-intelligence-service.ts | Proxied or direct? |
| Orders | GET/POST /orders | Routes | orderRepository | Commerce integration |

- [ ] **Step 1: Read UI analytics + reports + usage + AI sections** — identify every fetch call and the expected response shape.
- [ ] **Step 2: Read API analytics/billing/audit/AI routes** — confirm routes exist, check role gates (compliance_auditor for audit), query params.
- [ ] **Step 3: Read tenantAnalytics + auditRepository + linkClickRepository** — SQL correctness, time-range filtering, aggregation accuracy.
- [ ] **Step 4: Read ai-intelligence-service** — what routes does it expose? Is the gateway proxying to it or calling it directly? What Claude model/API is it using?
- [ ] **Step 5: Read billing-usage-service + reporting-service** — are these standalone HTTP services or called from gateway? Are their routes wired in docker-compose?
- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a7-analytics-reports-usage-ai.md`.
- [ ] **Step 7: Commit** `git commit -m "audit: A7 analytics+reports+usage+AI findings"`

---

### Task 8 (A8): Runtime Smoke Test

**Files to read/run:**
- `.claude/skills/run-hyfib-wa-app/smoke.sh` — read before running
- `docker-compose.yml` — verify service healthcheck definitions

**Output:** `docs/superpowers/audits/a8-runtime-smoke-test.md`

**Prerequisites:** Docker daemon must be running. If not, write findings as SKIP with reason.

- [ ] **Step 1: Verify Docker is running**

```bash
docker info --format '{{.ServerVersion}}' 2>&1
```

Expected: a version string (e.g. `29.5.3`). If `Cannot connect to the Docker daemon` → write A8 as SKIP, explain Docker not running, proceed to Task 9.

- [ ] **Step 2: Read smoke.sh before running**

Read `.claude/skills/run-hyfib-wa-app/smoke.sh` to understand assertions and timing. Note: first run takes 5–10 min to build images.

- [ ] **Step 3: Run smoke test**

```bash
.claude/skills/run-hyfib-wa-app/smoke.sh 2>&1 | tee /tmp/smoke-output.txt
```

Expected last line: `SMOKE PASS — tenant <uuid>` and exit 0.  
On failure: `SMOKE FAIL: <step>` — record the exact step and any preceding error output.

- [ ] **Step 4: Capture service health**

```bash
docker compose ps --format json 2>/dev/null | jq -r '.[] | "\(.Name) \(.Status)"'
```

Record which services are `(healthy)` vs `(unhealthy)` vs `(starting)`.

- [ ] **Step 5: Check for known gaps**

After smoke pass, verify these known-partial areas:
```bash
# Outbound to Meta fails by design (no real credentials) — confirm 503 in worker logs
docker compose logs notification-worker 2>/dev/null | grep -i "dispatch_failed\|meta_adapter" | tail -5

# SSE stream alive
curl -sk --max-time 3 http://localhost:18080/api/v1/events/stream \
  -H "x-tenant-id: $(cat /tmp/smoke-output.txt | grep 'tenant' | grep -o '[a-f0-9-]\{36\}' | head -1)" \
  -H "x-role: support_agent" -H "x-actor-id: smoke" | head -c 100
```

- [ ] **Step 6: Write findings** to `docs/superpowers/audits/a8-runtime-smoke-test.md`

Include: pass/fail per smoke assertion, service health table, any errors from step 5.

- [ ] **Step 7: Commit** `git commit -m "audit: A8 runtime smoke test findings"`

---

### Task 9: Consolidation — Merge All Findings

**Files to read:**
- `docs/superpowers/audits/a1-auth-setup-tenants.md`
- `docs/superpowers/audits/a2-inbox-conversations.md`
- `docs/superpowers/audits/a3-contacts-consent.md`
- `docs/superpowers/audits/a4-campaigns-templates.md`
- `docs/superpowers/audits/a5-automation-tasks-teams.md`
- `docs/superpowers/audits/a6-webhook-meta-adapter.md`
- `docs/superpowers/audits/a7-analytics-reports-usage-ai.md`
- `docs/superpowers/audits/a8-runtime-smoke-test.md`

**Output:** `docs/superpowers/audits/2026-06-29-feature-audit-findings.md`

- [ ] **Step 1: Tally all findings across agents**

Count PASS / GAP / PARTIAL / BUG per agent and overall.

- [ ] **Step 2: Write consolidated report**

```markdown
# HyFib Feature Audit — Findings Report
**Date:** 2026-06-29
**Method:** Parallel 8-agent audit (code + runtime)

## Scorecard

| Domain | PASS | PARTIAL | GAP | BUG | Total |
|---|---|---|---|---|---|
| A1 Auth + Setup + Tenants | | | | | |
| A2 Inbox + Conversations | | | | | |
| A3 Contacts + Consent | | | | | |
| A4 Campaigns + Templates | | | | | |
| A5 Automation + Tasks + Teams | | | | | |
| A6 Webhook + Meta Adapter | | | | | |
| A7 Analytics + Reports + Usage + AI | | | | | |
| A8 Runtime Smoke Test | | | | | |
| **TOTAL** | | | | | |

## Critical Issues (GAP + BUG)
[List each, ordered by user impact — feature broken = first]

## Partial Implementations
[Features that partially work — what's missing]

## Passing Features
[Summary of what works end-to-end]

## Prioritized Fix List
1. [Highest impact gap/bug]
2. ...
```

- [ ] **Step 3: Commit final report**

```bash
git add docs/superpowers/audits/
git commit -m "audit: consolidated feature audit findings report"
```
