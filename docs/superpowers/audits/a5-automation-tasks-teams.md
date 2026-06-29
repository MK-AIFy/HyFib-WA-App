# A5 Findings: Automation + Tasks + Teams

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Auto-reply rules list (GET /auto-reply-rules) | PASS | Route exists, returns `{ items }` | api-gateway/src/index.ts:2200 |
| Auto-reply rules create (POST /auto-reply-rules) | PASS | Role-gated, matchType validated against `["keyword","contains","regex","any"]`, keyword+replyText bounded, regex pre-compiled for validity | api-gateway/src/index.ts:2205 |
| Auto-reply toggle (PATCH /auto-reply-rules/:id) | PASS | UUID validated, role-gated, `enabled` type-checked | api-gateway/src/index.ts:2256 |
| matchType `keyword` handling in worker | PASS | Case-insensitive exact match | notification-worker/src/autoreply.ts:18 |
| matchType `contains` handling in worker | PASS | Case-insensitive substring | notification-worker/src/autoreply.ts:22 |
| matchType `regex` handling in worker | PASS | Invalid regex silently skips rule | notification-worker/src/autoreply.ts:25 |
| matchType `any` handling in worker | PASS | Returns rule unconditionally | notification-worker/src/autoreply.ts:16 |
| Automation rules list (GET /automation-rules) | PASS | Paginated, returns `{ items, total, limit, offset }` | api-gateway/src/index.ts:2318 |
| Automation rules create (POST /automation-rules) | PASS | Role-gated, name/triggerType/actionType required, validated against `AUTOMATION_TRIGGERS`/`AUTOMATION_ACTIONS` sets, assignee tenant-checked | api-gateway/src/index.ts:2325 |
| Automation rule toggle (PATCH /automation-rules/:id) | PASS | UUID validated, role-gated, `enabled` type-checked | api-gateway/src/index.ts:2382 |
| Automation trigger: `new_message` | PASS | Worker evaluates on inbound text/button/interactive; `matchesConditions` checks `conditions.keyword` against message text | notification-worker/src/index.ts:522, shared-core/src/automation.ts:19 |
| Automation trigger: `tag_added` | PASS | Called in gateway when tag added to contact; `matchesConditions` checks `conditions.tag` | api-gateway/src/index.ts:1792, shared-core/src/automation.ts:25 |
| Automation trigger: `conversation_assigned` | PASS | Called in gateway after assign; no extra conditions evaluated (correct — no defined conditions for this trigger) | api-gateway/src/index.ts:2062 |
| Automation trigger: `no_reply` | PASS | `startNoReplyScheduler` polls every 60 s, checks `delayMinutes` condition, fires `runAutomation` | api-gateway/src/index.ts:799 |
| Automation action: `add_tag` | PASS | Adds tag to contact in both worker and `runAutomation` paths | notification-worker/src/index.ts:541, api-gateway/src/index.ts:311 |
| Automation action: `assign_agent` | PASS | Tenant-scoped user lookup before assigning; both paths implemented | notification-worker/src/index.ts:544, api-gateway/src/index.ts:314 |
| Automation action: `create_task` | PASS | Task created with `source: "automation"`, dueAt/remindAt set from `dueInMinutes`; both paths implemented | notification-worker/src/index.ts:550, api-gateway/src/index.ts:318 |
| Automation action: `send_template` | PASS | Published to `AutomationTemplateRequested` queue; worker picks up and sends | notification-worker/src/index.ts:562, api-gateway/src/index.ts:330 |
| Task list (GET /tasks) with pagination | PASS | Supports `status`, `assignee` filter params, paginated with `limit`/`offset` | api-gateway/src/index.ts:2403 |
| Task create (POST /tasks) — title, dueAt, assignee | PASS | Title bounded (256), dueAt/remindAt ISO-8601 validated, assigneeUserId tenant-checked; `remindAt` defaults to `dueAt` | api-gateway/src/index.ts:2416 |
| Task update (PATCH /tasks/:id) — status change | PASS | Status validated against `["open","done","cancelled"]` | api-gateway/src/index.ts:2468 |
| Task reminder `task.reminder` SSE event | PASS | `startReminderScheduler` polls every 60 s; calls `due_task_reminders()` DB function (SECURITY DEFINER), marks `reminded_at`, broadcasts via `sseHub.broadcast` | api-gateway/src/index.ts:833 |
| Task reminder DB function | PASS | `due_task_reminders(p_limit)` selects `status='open' AND remind_at <= now() AND reminded_at IS NULL`; partial index exists | infra/postgres/init/011_scheduler_functions.sql:52 |
| Task reminder de-dupe | PASS | `reminded_at` column set after dispatch; DB function filters it out on next poll | api-gateway/src/index.ts:847, infra/postgres/init/010_automation_schedulers.sql:4 |
| Team list (GET /teams) | PASS | Returns all teams for tenant, ordered default-first then name | api-gateway/src/index.ts:1137 |
| Team create (POST /teams) | PASS | Role-gated (platform_owner/tenant_admin), name bounded (120), audit logged | api-gateway/src/index.ts:1142 |
| Team update (PATCH /teams/:id) | GAP | No route exists; UI has no rename/edit path either — team name is immutable post-creation | api-gateway/src/index.ts:1137-1165 |
| Team membership list (GET /teams/:id/members) | PASS | UUID validated, team existence checked | api-gateway/src/index.ts:1177 |
| Team membership add (POST /teams/:id/members) | PASS | Role-gated, UUID validated, userId tenant-checked via `userRepository.getById` | api-gateway/src/index.ts:1194 |
| Team membership remove (DELETE /teams/:id/members) | PASS | Role-gated; RLS on `team_members` ensures cross-tenant isolation | api-gateway/src/index.ts:1199 |
| Assign conversation to team (POST /conversations/:id/assign-team) | PASS | UUID validated, `teamRepository.getById(tenantId, teamId)` verifies ownership before assigning; SSE `conversation.team_assigned` broadcast | api-gateway/src/index.ts:2073 |
| RLS — teams table | PASS | `FORCE ROW LEVEL SECURITY` + policy on `tenant_id` | infra/postgres/init/007_phase1_crm.sql:87 |
| RLS — team_members table | PASS | `FORCE ROW LEVEL SECURITY` + policy on `tenant_id` | infra/postgres/init/007_phase1_crm.sql:94 |
| RLS — automation_rules table | PASS | `FORCE ROW LEVEL SECURITY` + policy | infra/postgres/init/009_automation_tasks.sql:23 |
| RLS — tasks table | PASS | `FORCE ROW LEVEL SECURITY` + policy | infra/postgres/init/009_automation_tasks.sql:49 |
| RLS — auto_reply_rules table | PASS | RLS + policy in marketing schema | infra/postgres/init/006_marketing.sql:99 |
| `teamRepository.getById` tenant scope | PARTIAL | WHERE clause only filters `id = $1`; tenant isolation relies entirely on RLS `FORCE ROW LEVEL SECURITY` via `withTenant`. This is safe due to FORCE RLS but query doesn't explicitly filter `tenant_id` | packages/persistence/src/repositories.ts:180 |
| `teamRepository.removeMember` tenant scope | PARTIAL | WHERE clause only filters `team_id` and `user_id`; relies on RLS. Safe but explicit `tenant_id` filter is missing | packages/persistence/src/repositories.ts:197 |
| `automationRuleRepository.list` RLS filter in count query | BUG | COUNT query `SELECT COUNT(*) FROM automation_rules` has no WHERE; under FORCE RLS this is safe, but if RLS were ever disabled the count would be cross-tenant. The data query correctly uses RLS. Low severity. | packages/persistence/src/repositories.ts:2173 |
| `matchesConditions` `no_reply`/`conversation_assigned` | PASS | Both triggers pass through `matchesConditions` without extra condition checks (correct: delayMinutes is evaluated separately in the no_reply scheduler at the caller level) | shared-core/src/automation.ts:17 |
| UI — assignee field missing from task create form | GAP | `showAddTask()` sends only `{ title, dueAt }` — no `assigneeUserId` picker, so tasks always have no assignee unless created by automation | web-portal/public/index.html:2637 |

---

## Issues (GAP / PARTIAL / BUG only)

### Team update (PATCH /teams/:id) — GAP
**File:** `services/api-gateway/src/index.ts:1137–1165`
**Detail:** No PATCH route exists for `/api/v1/teams/:id`. The `teamRepository` also has no `update()` method. The UI exposes no rename button.
**Impact:** Team names are permanently immutable after creation. Operators cannot correct a misspelled team name without direct DB access.

---

### UI — Task assignee field missing — GAP
**File:** `services/web-portal/public/index.html:2637`
**Detail:** `showAddTask()` builds `POST /tasks` with only `{ title, dueAt }`. The `assigneeUserId` field is accepted and validated by the API but never surfaced in the creation modal.
**Impact:** Manually created tasks always have no assignee. Only automation-created tasks can carry an assignee (via `create_task` action, which also doesn't set one today since `dueInMinutes` drives scheduling but `assigneeUserId` is not in `AutomationActionConfig`).

---

### `teamRepository.getById` — no explicit tenant_id column filter — PARTIAL
**File:** `packages/persistence/src/repositories.ts:180`
**Detail:** `WHERE id = $1` with no `AND tenant_id = $2`. Tenant isolation depends solely on PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`) being active. This is currently safe, but the pattern is inconsistent with other repositories (e.g., `userRepository.getById` also uses only the RLS path).
**Impact:** If RLS is ever bypassed (e.g., a `SECURITY DEFINER` function or a superuser connection is introduced), this query would return any team regardless of tenant. Low severity — defense-in-depth gap only.

---

### `teamRepository.removeMember` — no explicit tenant_id filter — PARTIAL
**File:** `packages/persistence/src/repositories.ts:197`
**Detail:** `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2` relies on RLS alone.
**Impact:** Same RLS-bypass risk as above. Low severity.

---

### `automationRuleRepository.list` COUNT query missing RLS WHERE — BUG (low severity)
**File:** `packages/persistence/src/repositories.ts:2173`
**Detail:** `SELECT COUNT(*)::text AS total FROM automation_rules` — no explicit `WHERE`. Because `automation_rules` has `FORCE ROW LEVEL SECURITY`, the count is scoped by `app.tenant_id` set in `withTenant`. Safe today.
**Impact:** If RLS is ever disabled or bypassed, the total count returned in pagination would be inflated to the sum across all tenants, while the items list remains tenant-scoped — causing misleading page counts for the UI. Same pattern exists in `taskRepository.list` (line 2289).

---

## Summary

**PASS: 32 | GAP: 2 | PARTIAL: 2 | BUG: 1 (low severity)**

**Critical Findings:**
- None. The task reminder mechanism is **fully implemented**: a 60-second polling scheduler (`startReminderScheduler`) calls the `due_task_reminders()` PostgreSQL SECURITY DEFINER function, marks each task with `reminded_at` to prevent re-firing, and broadcasts `task.reminder` SSE events via `SseHub.broadcast`. This is wired up on server start at `api-gateway/src/index.ts:2673`.
- The only structural gap is the missing **PATCH /teams/:id** route — teams cannot be renamed.
- The UI **task creation form** is missing the assignee picker (API supports it, UI doesn't surface it).
- Three repositories use implicit-RLS-only filtering without explicit `tenant_id` in the WHERE clause (low risk under FORCE RLS, but a defence-in-depth gap).
