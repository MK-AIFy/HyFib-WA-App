# A1 Findings: Auth + Setup + Tenants

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Create tenant (setup step 1) | PASS | UI calls `POST /tenants` with explicit `platform_owner` role override; gateway enforces `hasAnyRole(auth, ["platform_owner"])`; `tenantRepository.create` uses parameterized `INSERT INTO tenants (name) VALUES ($1)` | api-gateway/src/index.ts:1033, index.html:1033 |
| Create tenant (Tenants view — in-app) | BUG | UI calls `POST("/tenants", { name })` via `POST()` helper which uses `S.role` — the current role. If user switches to any non-`platform_owner` role, the POST will fail with 403; no role override passed | index.html:3335 |
| List tenants (GET /tenants) | PASS | Gateway enforces `platform_owner`; UI guards render with `S.role !== "platform_owner"` client-side pre-check; uses `tenantRepository.list()` with parameterized query | api-gateway/src/index.ts:1025–1031, index.html:3287 |
| Existing tenant login (setup step 1 skip) | PASS | UI sets `tenantId` from field, calls `GET /channels/whatsapp` with that id as `x-tenant-id`; if channel exists, calls `initApp()`; if not, advances to step 2 | index.html:1006–1025 |
| Create user (POST /users) | PASS | Route exists; enforces `platform_owner` or `tenant_admin`; validates email, displayName, roles array; rejects invalid role names; uses `userRepository.create` with `withTenant` RLS | api-gateway/src/index.ts:1094–1130 |
| List users (GET /users) | PARTIAL | Route exists; no role gate on GET — any authenticated tenant user can list; admins get full user records, non-admins get only `{id, displayName}`. No UI view for user management exists (only used as a picker in conversation assign and team members modals) | api-gateway/src/index.ts:1084–1093 |
| Channel registration (POST /channels/whatsapp) | PASS | Setup step 2 calls with `tenant_admin` role override; gateway enforces `platform_owner` or `tenant_admin`; body validated with `boundedText`; access token length-capped at 4096; `channelRepository.create` uses parameterized query inside `withTenant` | api-gateway/src/index.ts:1214–1264, index.html:1076 |
| List channels (GET /channels/whatsapp) | PARTIAL | Route exists, no auth gate on GET — any authenticated user with a tenant can list channels; `channelRepository.list` is RLS-scoped via `withTenant`; access token not exposed in response | api-gateway/src/index.ts:1210–1212 |
| WhatsApp settings get (GET /channels/whatsapp/settings) | PASS | Route exists; returns settings or config defaults; uses `whatsappSettingsRepository.getByTenant` with `withTenant` RLS | api-gateway/src/index.ts:1270–1279 |
| WhatsApp settings update (PUT /channels/whatsapp/settings) | PASS | Route enforces `platform_owner` or `tenant_admin`; validates all fields with `clampInt`/`boundedText`; uses upsert with parameterized query; audit logged | api-gateway/src/index.ts:1282–1308 |
| WhatsApp settings — UI exposure | GAP | `renderSettings` view does not call `GET /channels/whatsapp/settings` or expose a PUT form. The settings endpoint exists and is correct server-side, but there is no UI surface for tenant admins to view/update retry, rate-limit, or callback URL config | index.html:2962–3032 |
| RBAC: analyst blocked on POST /contacts | PASS | `canCreateContact` restricts to `["platform_owner", "tenant_admin", "marketing_manager"]`; analyst is excluded and receives 403 | api-gateway/src/authorization.ts:5, api-gateway/src/index.ts:1516 |
| Role switcher sends correct x-role header | PASS | `S.role` is updated on `onchange`; persisted to `localStorage`; `api()` sends it as `x-role: effectiveRole` on every request | index.html:1146, 886 |
| Logout clears localStorage | PASS | `logout()` removes all 5 keys (`hf_tid`, `hf_tname`, `hf_chid`, `hf_chphone`, `hf_role`), resets S state, aborts SSE, and calls `renderSetup()`. No server call needed — correct. | index.html:1219–1228 |
| Dead route: second /api/v1/tenants block | BUG | A second `if (path === "/api/v1/tenants")` block at line 2589 (proxy to tenant-service) is unreachable: the first block at line 1024 always returns before the tenant-scoped section where the second appears. If a `tenantServiceUrl` microservice ever activates, this path will never be reached. | api-gateway/src/index.ts:2589 |
| `hasAccessToken` field in Settings UI | BUG | `renderSettings` reads `ch.hasAccessToken` to show "stored"/"not set" badge (line 3026). The `channelRepository.list()` returns `WhatsAppChannel` type which has no `hasAccessToken` field. The value will always be `undefined` (falsy), always rendering "not set" even when a token is stored. | index.html:3026, repositories.ts:371–377, shared-core/src/index.ts:60–69 |
| `whatsappSettingsRepository.getByTenant` query | BUG | `getByTenant` uses `SELECT ... FROM whatsapp_settings LIMIT 1` with no `WHERE tenant_id = ...` clause inside a `withTenant` block. Correctness depends entirely on Postgres RLS policy being active on that table. If RLS is not enabled on `whatsapp_settings`, this returns any tenant's settings. | repositories.ts:284–288 |
| `userRepository.list` USER_SELECT missing WHERE clause | PARTIAL | `list(tenantId)` runs `${USER_SELECT} GROUP BY u.id` (no `WHERE u.tenant_id = $1`). The `USER_SELECT` has no WHERE clause. Tenant isolation relies solely on RLS (`withTenant` sets `app.tenant_id`). If RLS is enforced on the `users` table, this is fine; if not, all users across tenants are returned. | repositories.ts:99–104, 124–129 |

Status values: PASS (works end-to-end), GAP (UI call has no backend, or backend has no repo), PARTIAL (partially wired), BUG (logic error)

---

## Issues (GAP / PARTIAL / BUG only)

### Create tenant (Tenants view) — BUG
**File:** `services/web-portal/public/index.html:3335`
**Detail:** `showCreateTenant()` calls `POST("/tenants", { name })` which uses the `POST()` helper. That helper sends `S.role` as `x-role`. The Tenants view is only rendered when `S.role === "platform_owner"` (client-side guard), but there is no lock preventing a user from calling `showCreateTenant()` directly or after switching roles mid-session. In contrast, the setup-flow path at line 1033 correctly uses `api("POST", "/tenants", ..., "", "platform_owner")` with an explicit override.
**Impact:** If a user switches their role away from `platform_owner` after landing on the Tenants view and then creates a tenant, the POST will be rejected by the gateway with 403. Server-side correctness is not broken (gateway enforces the role), but the UX silently fails without the same override used in setup.

### List users (GET /users) — PARTIAL
**File:** `services/api-gateway/src/index.ts:1084–1093`
**Detail:** Any tenant-scoped authenticated role can GET /users. Non-admin roles receive a reduced payload `{id, displayName}`, but there is no role gate to restrict the list entirely. The UI has no dedicated "Users" management screen — users only appear in team-member and conversation-assign modals.
**Impact:** Any logged-in user can enumerate all user IDs and display names in their tenant. This is an internal information disclosure — low severity within a tenant, but worth noting.

### List channels (GET /channels/whatsapp) — PARTIAL
**File:** `services/api-gateway/src/index.ts:1210–1212`
**Detail:** No role gate on the GET. Any authenticated tenant user can retrieve the list of WhatsApp channels (WABA ID, phone number ID, display phone, status). Access token is not returned (correct — it's encrypted at rest). RLS via `withTenant` prevents cross-tenant leakage.
**Impact:** Internal information disclosure within tenant — channel metadata exposed to all roles including `analyst` and `compliance_auditor`.

### WhatsApp settings — UI exposure — GAP
**File:** `services/web-portal/public/index.html:2962–3032`
**Detail:** `renderSettings()` calls `GET /channels/whatsapp` to show channel info, but never calls `GET /channels/whatsapp/settings`. There is no UI form to update `retryMaxAttempts`, `retryBaseDelayMs`, `outboundRateLimitPerMinute`, or `statusCallbackUrl`. The backend endpoint (`PUT /channels/whatsapp/settings`) is fully implemented and gated to admins.
**Impact:** Tenant admins cannot configure retry limits or rate limits through the UI. They must use direct API calls.

### `hasAccessToken` field missing from channel response — BUG
**File:** `services/web-portal/public/index.html:3026`, `packages/persistence/src/repositories.ts:371–377`, `packages/shared-core/src/index.ts:60–69`
**Detail:** The Settings view shows whether an access token is stored using `ch.hasAccessToken`. The `WhatsAppChannel` interface does not include this field. `channelRepository.list()` maps rows using `mapChannel()` which returns `WhatsAppChannel` without any `hasAccessToken` property. The field is always `undefined` (falsy).
**Impact:** The "Access Token" indicator in Settings always shows "not set" (red badge), even when a token is configured. This misleads operators into re-entering tokens unnecessarily.

### Dead `/api/v1/tenants` proxy block — BUG
**File:** `services/api-gateway/src/index.ts:2589–2619`
**Detail:** A second route block `if (path === "/api/v1/tenants")` appears at line 2589 inside the tenant-scoped section (after line 1058 where `tenantId` is resolved). It proxies to a `tenantServiceUrl` microservice. This block is unreachable: the first block at line 1024 handles all `/api/v1/tenants` requests and always `return`s. The handler at line 2589 will never execute.
**Impact:** If a tenant-service microservice is deployed expecting this proxy path to forward calls, it will never receive them. Changes to tenant management logic in the second block are silently ignored.

### `whatsappSettingsRepository.getByTenant` missing WHERE clause — BUG
**File:** `packages/persistence/src/repositories.ts:284–288`
**Detail:** Query is `SELECT ... FROM whatsapp_settings LIMIT 1` with no `WHERE tenant_id = ...` explicit filter. The `withTenant` wrapper sets `app.tenant_id` for RLS, so correctness depends on a Postgres RLS policy existing on `whatsapp_settings`. If that policy is absent or misconfigured, this query returns the first settings row in the table regardless of tenant.
**Impact:** Potential cross-tenant data leak in settings; or if only one row exists globally, settings are shared across all tenants.

### `userRepository.list` relies solely on RLS — PARTIAL
**File:** `packages/persistence/src/repositories.ts:99–129`
**Detail:** `USER_SELECT` and the `list()` method have no `WHERE u.tenant_id = $1` clause — tenant scoping depends 100% on `withTenant` RLS. This is a defense-in-depth gap: if the RLS policy on `users` is dropped or misconfigured, `list()` returns all users in the database.
**Impact:** Cross-tenant user data leak if RLS is not enforced. The pattern differs from other repositories (e.g., `channelRepository`) where `WHERE` clauses on `tenant_id` appear explicitly in addition to RLS.

---

## Summary

| Status | Count | Features |
|---|---|---|
| PASS | 8 | Create tenant (setup), List/get tenants, Existing tenant login, Create user, Register channel, WA settings GET, WA settings PUT, Analyst blocked on POST /contacts, Role switcher, Logout |
| GAP | 1 | WhatsApp settings UI (no form to view/edit) |
| PARTIAL | 2 | List users (no role gate), List channels (no role gate) |
| BUG | 4 | In-app create tenant uses `S.role` not platform_owner override; `hasAccessToken` always undefined; dead /api/v1/tenants proxy block; `getByTenant` missing WHERE clause |

**Most critical issues (in priority order):**
1. `whatsappSettingsRepository.getByTenant` missing `WHERE` clause — potential cross-tenant data leak if RLS not enforced (`repositories.ts:285`)
2. Dead `/api/v1/tenants` proxy block — if a tenant-service microservice is wired up, it will never receive calls (`api-gateway/src/index.ts:2589`)
3. `hasAccessToken` always undefined — operators always see "not set" for access token in Settings (`index.html:3026`)
4. In-app create-tenant calls `POST()` with `S.role` instead of forcing `platform_owner` override — UX failure if role was switched (`index.html:3335`)
