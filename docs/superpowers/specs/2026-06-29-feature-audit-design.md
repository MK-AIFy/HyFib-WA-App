# Feature Audit Design — HyFib WhatsApp Business Platform

**Date:** 2026-06-29  
**Scope:** Full UI + Backend + Services integration audit  
**Approach:** Parallel multi-agent (Approach B)

---

## Goal

Verify that every feature in the platform is correctly implemented end-to-end:
- UI calls the right API endpoint with the right shape
- API gateway route exists, enforces auth/RBAC, and calls the right downstream
- Downstream service/repository is wired and has correct DB queries
- Integration is unbroken from browser → gateway → service → DB → response

## Audit Layers (per feature)

| Layer | What to check |
|---|---|
| **UI** | Correct endpoint called, error handling present, state updated on response |
| **API** | Route exists in `api-gateway/src/index.ts`, auth enforced, RBAC role-gated |
| **Service** | Gateway calls downstream service or repository correctly |
| **DB** | Repository query matches schema, returns expected shape |
| **Integration** | End-to-end chain is unbroken; no stubs, no missing wiring |

## Finding Severity

| Status | Meaning |
|---|---|
| **PASS** | Correctly implemented end-to-end |
| **GAP** | UI calls something with no backend, or backend has no service/DB |
| **PARTIAL** | Partially wired (e.g. UI + API exist but service is a stub) |
| **BUG** | Logic error found in the chain |

---

## Agent Breakdown

### A1 — Auth + Setup + Tenants
- Setup flow (Step 1: tenant creation or existing tenant ID; Step 2: channel registration)
- Tenant CRUD (`POST/GET /tenants`, `GET /tenants/:id`)
- User management (`POST/GET /users`, roles)
- Channel registration (`POST/GET /channels/whatsapp`)
- WhatsApp settings (`GET/PUT /channels/whatsapp/:id/settings`)
- RBAC enforcement across all roles (platform_owner, tenant_admin, marketing_manager, sales_agent, support_agent, analyst, compliance_auditor)

### A2 — Inbox + Conversations
- Conversation list (`GET /conversations`) with filters and pagination
- Message history (`GET /conversations/:id/messages`)
- Send message (`POST /conversations/:id/messages`) — text, media, interactive
- SSE live stream (`GET /events/stream`)
- Assign conversation to user (`POST /conversations/:id/assign`)
- Assign conversation to team (`POST /conversations/:id/assign-team`)
- Change conversation state (`POST /conversations/:id/state`)
- Internal notes (`GET/POST /conversations/:id/notes`)
- Saved replies (`GET/POST /saved-replies`, PATCH `/saved-replies/:id`)

### A3 — Contacts + Consent
- Contact CRUD (`GET/POST /contacts`, `GET/PATCH /contacts/:id`)
- Search contacts (`GET /contacts?q=`)
- Grant consent (`POST /contacts/:id/consent`)
- Opt-out (`POST /contacts/:id/opt-out`)
- Import CSV (`POST /contacts/import`)
- Export CSV (`GET /contacts/export`)
- Contact profile modal (tags, timeline, notes)
- Contact notes (`GET/POST /contacts/:id/notes`)
- Tags (`GET /tags`)

### A4 — Campaigns + Templates
- Template list + sync (`GET /templates`, `POST /templates/sync`)
- Campaign CRUD (`GET/POST /campaigns`, `GET/PATCH /campaigns/:id`)
- Campaign dispatch (`POST /campaigns/:id/dispatch`)
- Dispatch pipeline: gateway → notification-worker → meta-adapter
- Consent gating (contacts must have active consent)
- Policy engine: quiet hours, frequency cap, template category
- Campaign recipients (`GET /campaigns/:id/recipients`)
- Variable mapping in dispatch

### A5 — Automation + Tasks + Teams
- Auto-reply rules (`GET/POST /auto-reply-rules`, `PATCH /auto-reply-rules/:id`)
- Automation rules (`GET/POST /automation-rules`, `PATCH /automation-rules/:id`)
- Task management (`GET/POST /tasks`, `PATCH /tasks/:id`)
- Task reminders (SSE `task.reminder` event)
- Team CRUD (`GET/POST /teams`, `PATCH /teams/:id`)
- Team membership (`POST /teams/:id/members`)

### A6 — Webhook + Meta Adapter
- Inbound webhook verification (`GET /webhooks/meta/whatsapp` — token verify)
- Inbound webhook ingestion (`POST /webhooks/meta/whatsapp` — HMAC + process)
- webhook-ingestor service: HMAC check, RabbitMQ publish
- meta-adapter: Graph API calls, message send, media upload
- Message normalization (`normalize.ts`)
- Idempotency (duplicate wamid handling)
- Opt-out/opt-in detection from inbound STOP/START messages

### A7 — Analytics + Reports + Usage + AI
- Analytics KPIs (`GET /analytics`)
- Analytics by campaign (`GET /analytics?campaignId=`)
- Reports view (`GET /reports`)
- Link click tracking (`GET /analytics/link-clicks`)
- Usage/billing (`GET /billing/usage`)
- AI intelligence service: routes, prompts, integration with gateway
- Audit log (`GET /audit`)

### A8 — Runtime Smoke Test
- Start stack with `smoke.sh`
- Assert: gateway health (`database: true`), portal health, TLS edge
- Exercise: tenant → channel → contact + consent → template → campaign dispatch → inbound webhook → conversation + messages → agent reply
- Assert: analytics reflect the run, audit log entries present, SSE stream alive
- Report: pass/fail per assertion with HTTP response evidence

---

## Consolidation

After all 8 agents report, a consolidation pass produces:
1. **Critical gaps** — features with no backend or broken wiring
2. **Partial implementations** — UI exists but backend is stub or vice versa
3. **Bugs** — logic errors in any layer
4. **Passing features** — confirmed end-to-end
5. **Prioritized fix list** — ordered by user impact

---

## Deliverable

A single findings report at `docs/superpowers/audits/2026-06-29-feature-audit-findings.md` with per-domain tables and a summary scorecard.
