# A2 Findings: Inbox + Conversations

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Conversation list (pagination + state filter) | PARTIAL | Pagination works; `state` filter works; BUT `contactName`, `contactPhone`, `lastMessage` are used by UI yet absent from the `Conversation` type and DB SELECT | repositories.ts:1196, index.html:1283–1299 |
| Message history (payload shape) | PASS | UI reads `m.payload.text \|\| m.text`; inbound worker stores `payload.text = inbound.text`; outbound session stores `payload` with kind-specific keys. Shape is consistent. | repositories.ts:1364–1376, index.html:1378–1383 |
| Message `occurredAt` vs `createdAt` | GAP | UI calls `fmtTime(m.occurredAt \|\| m.createdAt)` but `Message` type only exposes `createdAt`. `occurredAt` is always undefined; fallback to `createdAt` saves rendering but intent is wrong. | shared-core/src/index.ts:262–272, index.html:1389 |
| Send text message POST /conversations/:id/messages | PASS | Route exists, auth enforced (5 roles), body validated (kind, text, length), enqueues to outbox transactionally | index.ts:2158–2197 |
| Assign conversation to user | PASS | POST /conversations/:id/assign, role-gated (4 roles), broadcasts SSE `conversation.assigned`, runs automation | index.ts:2047–2071 |
| Assign conversation to team | PASS | POST /conversations/:id/assign-team, role-gated, UUID validated, team existence checked, broadcasts `conversation.team_assigned` | index.ts:2073–2096 |
| Change conversation state | PASS | POST /conversations/:id/state, enum validated (open/pending/closed), SSE broadcast, role-gated | index.ts:2098–2117 |
| Conversation notes (GET/POST) | PASS | Routes exist, GET no role gate (any authenticated user), POST gated to 5 roles, bounded text, audit logged | index.ts:2119–2156 |
| Saved replies (GET/POST) | PARTIAL | GET and POST work; UI calls `PATCH /saved-replies/:id {enabled}` via `toggleRule` on saved-reply items — no such route exists (PATCH not implemented); UI also lacks a PATCH call path, but auto-reply PATCH is at `/auto-reply-rules/:id`. No `enabled` flag on `SavedReply` type at all. | index.ts:2277–2315, index.html:1472–1511 |
| Auto-reply rules (GET/POST/PATCH) | PASS | GET list, POST create (role-gated, validated), PATCH /:id {enabled} all present; `matchType` enum validated; regex compiled server-side | index.ts:2199–2274 |
| SSE stream — tenant isolation | PASS | `sseHub.addClient(tenantId, sink)` scopes each client by resolved `tenantId` from auth; `broadcast(tenantId, ...)` fans only to that tenant's clients | sse-hub.ts:26–44, index.ts:1077 |
| SSE stream — reconnect after disconnect | PASS | UI catches non-AbortError and calls `setTimeout(connectSSE, 6000)` | index.html:952–959 |
| SSE client cleanup on disconnect | PASS | `req.on('close', () => sseHub.removeClient(tenantId, clientId))` is wired | index.ts:1079 |
| SSE keepalive (ping) | PASS | `sseHub.startKeepAlive()` sends comment frames every 25 s | sse-hub.ts:83–89, index.ts:912 |
| onSSE handler — task.reminder | PASS | Handled: shows toast | index.html:966–968 |
| onSSE handler — conversation.assigned | PASS | Handled: calls `loadConvList()` | index.html:973–976 |
| onSSE handler — conversation.state_changed | PASS | Handled: calls `loadConvList()` | index.html:973–976 |
| onSSE — inbound message refresh | PASS | If `pl.conversationId === S.activeConvId`, calls `loadMessages` | index.html:978–980 |
| onSSE — conversation.team_assigned topic | GAP | `conversation.team_assigned` is broadcast by server but `onSSE` only checks `conversation.assigned` and `conversation.state_changed`; team assignment goes unhandled | index.html:973, index.ts:2093 |
| Auto-reply worker — rule load order | PASS | `listEnabled` orders by `priority DESC, created_at ASC`; `matchAutoReply` iterates in that order and returns first match | repositories.ts:2038–2044, autoreply.ts:12–33 |
| Auto-reply worker — matchType evaluation | PASS | All four types (keyword, contains, regex, any) implemented; regex errors caught and skipped | autoreply.ts:15–30 |
| Auto-reply worker — enqueue reply | PASS | Matched rule enqueues `WhatsAppOutboundRequested` via outbox transactionally | notification-worker/src/index.ts:499–519 |
| Auto-reply for button/interactive messages | PARTIAL | Worker checks `inbound.type === "text" \|\| "button" \|\| "interactive"` but passes `inbound.text` to `matchAutoReply`. For `interactive` type the text field is empty; the intent (e.g. match button reply text) is not extracted | notification-worker/src/index.ts:495–498 |
| Conversation list — missing contact denormalized fields | BUG | UI reads `c.contactName`, `c.contactPhone`, `c.lastMessage` but these fields do not exist on the `Conversation` DB type or CONV_SELECT. Conversation list will display "Unknown" for all names/phones and "—" for all previews. | repositories.ts:1172–1197, index.html:1284–1300 |
| Message list — no `total` returned | GAP | `GET /conversations/:id/messages` returns `{ items }` without pagination metadata (total/offset). UI does not paginate messages; no load-more on older messages possible. | index.ts:2164–2169 |
| Saved replies PATCH (toggle enabled) | GAP | `toggleRule` in UI attempts `PATCH /auto-reply-rules/:ruleId` which is correct for auto-reply; but the `showSavedReplies` modal uses the same control pattern — a PATCH on saved replies is absent. `SavedReply` type has no `enabled` field, only `savedReplyRepository.delete`. No issue in the auto-reply toggle itself. | index.ts:2302–2315 |
| Conversation list assignee filter | GAP | UI passes `S.convFilter.assignee` to list query but `loadConvList` never builds `assignee=` query param (only `state=` is appended). The UI filter select for assignee is also absent from `renderInbox`. | index.html:1261–1310 |

---

## Issues (GAP / PARTIAL / BUG only)

### Conversation list — contactName/contactPhone/lastMessage missing — BUG

**File:** `packages/persistence/src/repositories.ts:1196` and `services/web-portal/public/index.html:1283–1299`

**Detail:** The `Conversation` DB type (`ConversationRow`) and the SQL SELECT only return `id, tenant_id, contact_id, channel_id, last_message_at, last_inbound_at, assigned_user_id, state`. The `Conversation` shared-core interface (shared-core/src/index.ts:230) does not include `contactName`, `contactPhone`, or `lastMessage`. The UI in `loadConvList` reads `c.contactName`, `c.contactPhone`, and `c.lastMessage` directly. All three are always `undefined`.

**Impact:** Every conversation in the inbox list renders as "Unknown" for the name, empty phone, and "—" as the message preview. Contacts cannot be identified in the inbox at a glance.

---

### Conversation list — assignee filter not wired — GAP

**File:** `services/web-portal/public/index.html:1261–1267`

**Detail:** `loadConvList` builds the query string as `offset=N` plus optionally `state=X`, but there is no `assignee=` parameter ever appended even though `S.convFilter.assignee` exists in state. The backend supports `assignee` via `assignedUserId` filter in `conversationRepository.list`.

**Impact:** The agent filter is silently ignored. All conversations are returned regardless of assigned user.

---

### SSE onSSE — conversation.team_assigned not handled — GAP

**File:** `services/web-portal/public/index.html:970–980` and `services/api-gateway/src/index.ts:2093`

**Detail:** The server broadcasts topic `conversation.team_assigned` when a team is assigned (line 2093 of index.ts), but `onSSE` only checks for `conversation.assigned` and `conversation.state_changed`. The team-assignment event falls through to the generic `loadConvList()` call at line 971 (the general SSE reload happens when `S.view === 'inbox'`), so the list does get refreshed, but the active chat header is never updated with new team info.

**Impact:** Minor: the list refreshes but the chat header's team state is stale until the user re-selects the conversation.

---

### Message timestamp — `occurredAt` undefined — GAP

**File:** `services/web-portal/public/index.html:1389` and `packages/shared-core/src/index.ts:271`

**Detail:** The UI renders `fmtTime(m.occurredAt || m.createdAt)`. The `Message` type exposes only `createdAt`; there is no `occurredAt` field anywhere in the persistence layer or type definitions. The `|| m.createdAt` fallback works correctly, but the primary field name is wrong and would fail silently if fallback were ever removed.

**Impact:** Low severity — timestamps render correctly via fallback. But it signals a dead code path (`occurredAt` always undefined) and creates a false expectation in the codebase.

---

### Auto-reply — interactive message text not extracted — PARTIAL

**File:** `services/notification-worker/src/index.ts:495–498`

**Detail:** For inbound messages of `type === "interactive"`, the worker passes `inbound.text` to `matchAutoReply`. However, for WhatsApp interactive messages (button reply, list reply), the user's selection is stored in `inbound.interactive.button_reply.title` or `inbound.interactive.list_reply.title`, not in `inbound.text` (which is empty). The keyword match therefore never fires for interactive responses.

**Impact:** Auto-reply rules with `matchType=keyword/contains/regex` will never trigger on interactive button/list messages. Rules with `matchType=any` will still fire.

---

### Saved replies — no PATCH toggle endpoint — GAP

**File:** `services/api-gateway/src/index.ts:2277–2315`

**Detail:** `savedReplyRepository` and the `SavedReply` type have no `enabled` field. No `PATCH /saved-replies/:id` endpoint exists. The UI's saved-replies modal does not expose a toggle (unlike auto-reply rules), so this is not an active user-facing bug. However, if someone adds an `enabled` toggle to the saved-replies UI following the same pattern as auto-reply rules, it would silently fail with 404.

**Impact:** Currently non-breaking (UI does not attempt the call). Risk: future regression if UI is extended without adding the endpoint.

---

### Message list — no pagination — GAP

**File:** `services/api-gateway/src/index.ts:2164–2169`

**Detail:** `GET /conversations/:id/messages` returns `{ items }` only. The `before` cursor param exists in the repo but the UI never passes it. For conversations with many messages only the latest 50 are shown (default limit), and there is no load-more button.

**Impact:** Users cannot scroll back beyond the most recent 50 messages in any conversation.
