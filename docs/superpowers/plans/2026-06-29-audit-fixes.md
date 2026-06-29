# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Fix all 14 bugs, 18 partials, and 17 gaps identified in the 2026-06-29 feature audit, in priority order: compliance bugs → core feature bugs → data integrity → partials → gaps.

**Architecture:** Changes are batched by module so parallel agents never touch the same file. Five parallel agents cover the five affected modules. Each agent builds its module after changes and commits.

**Tech Stack:** TypeScript ESM, pnpm workspaces, PostgreSQL, RabbitMQ, vanilla-JS SPA.

## Global Constraints
- Never modify more than one module per agent (CLAUDE.md rule)
- Each agent runs `pnpm -r build` after changes to confirm type-check passes
- All SQL uses parameterized queries — no string interpolation
- Commits use conventional commit format: `fix:` / `feat:` prefix

---

## Module Map

| Agent | Module | Fixes |
|---|---|---|
| F1 | `packages/persistence/src/repositories.ts` + `packages/shared-core/src/index.ts` | BUG-03, BUG-05, BUG-08, BUG-09, P-05, P-08, bulkUpsert tags/country |
| F2 | `services/notification-worker/src/index.ts` + `autoreply.ts` | BUG-01, P-01 |
| F3 | `services/api-gateway/src/csv.ts` | BUG-07 |
| F4 | `services/api-gateway/src/index.ts` | BUG-02, BUG-06(role), GAP-03, GAP-06, GAP-09, P-06 |
| F5 | `services/web-portal/public/index.html` | BUG-04, BUG-06(UI), GAP-02, GAP-04, GAP-05, GAP-07 |

---

## Task F1: persistence/repositories.ts + shared-core/index.ts

### BUG-03 — Consent grant idempotency (line 1019)
Replace bare INSERT with conditional INSERT:
```typescript
await client.query(
  `INSERT INTO consent_records (tenant_id, contact_id, channel, source, policy_version, granted_at)
   SELECT $1, $2, 'whatsapp', $3, $4, now()
   WHERE NOT EXISTS (
     SELECT 1 FROM consent_records
     WHERE contact_id = $2 AND channel = 'whatsapp' AND revoked_at IS NULL
   )`,
  [tenantId, contactId, input.source, input.policyVersion]
);
```

### BUG-05 — Conversation list missing contactName/contactPhone/lastMessage (line 1196)

Add to `ConversationRow` interface:
```typescript
contact_name: string | null;
contact_phone: string | null;
last_message: string | null;
```

Replace `CONV_SELECT` constant:
```typescript
const CONV_SELECT = `
  SELECT c.id, c.tenant_id, c.contact_id, c.channel_id,
         c.last_message_at, c.last_inbound_at, c.assigned_user_id, c.state,
         TRIM(CONCAT(co.first_name, ' ', co.last_name)) AS contact_name,
         co.phone_e164 AS contact_phone,
         (SELECT m.payload->>'text'
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1) AS last_message
  FROM conversations c
  LEFT JOIN contacts co ON co.id = c.contact_id`;
```

Update `mapConversation`:
```typescript
function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    channelId: row.channel_id,
    contactName: row.contact_name?.trim() || undefined,
    contactPhone: row.contact_phone ?? undefined,
    lastMessage: row.last_message ?? undefined,
    lastMessageAt: row.last_message_at?.toISOString(),
    lastInboundAt: row.last_inbound_at?.toISOString(),
    assignedUserId: row.assigned_user_id ?? undefined,
    state: (row.state ?? "open") as Conversation["state"]
  };
}
```

Also update `Conversation` interface in `packages/shared-core/src/index.ts`:
```typescript
export interface Conversation {
  // existing fields...
  contactName?: string;
  contactPhone?: string;
  lastMessage?: string;
}
```

Note: `getById` and `findOrCreate` also use `CONV_SELECT` — the JOIN is safe for those too.

### BUG-08 — Analytics missing conversations count (line 1607)

Add conversations query to the `Promise.all` in `tenantAnalytics`:
```typescript
const [templates, campaigns, contacts, conversations] = await Promise.all([
  client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM templates"),
  client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM campaigns"),
  client.query<{ total: string; opted_out: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE metadata->>'optedOut' = 'true')::text AS opted_out
     FROM contacts`
  ),
  client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM conversations")
]);
```

Update return + interface:
```typescript
export interface TenantAnalytics {
  templates: number;
  campaigns: number;
  contacts: number;
  conversations: number;
  optOutRate: number;
}
// in return:
conversations: Number(conversations.rows[0]?.count ?? "0"),
```

### BUG-09 — whatsappSettings getByTenant missing WHERE (line 285)
```typescript
const result = await client.query<WhatsAppSettingsRow>(
  `${WHATSAPP_SETTINGS_SELECT} FROM whatsapp_settings
   WHERE tenant_id = current_setting('app.tenant_id', true)::uuid LIMIT 1`
);
```

### P-05 — hasAccessToken always undefined

In `packages/shared-core/src/index.ts`, add optional field to `WhatsAppChannel`:
```typescript
export interface WhatsAppChannel {
  // ...existing...
  hasAccessToken?: boolean;
}
```

In `repositories.ts`, update `CHANNEL_COLUMNS`:
```typescript
const CHANNEL_COLUMNS =
  "id, tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, created_at, (access_token_encrypted IS NOT NULL) AS has_access_token";
```

Update `ChannelRow` interface:
```typescript
interface ChannelRow {
  // ...existing...
  has_access_token: boolean;
}
```

Update `mapChannel`:
```typescript
function mapChannel(row: ChannelRow): WhatsAppChannel {
  return {
    // ...existing...
    hasAccessToken: row.has_access_token,
  };
}
```

### P-08 — automationRuleRepository.list COUNT cross-tenant (line 2173)
```typescript
const totalResult = await client.query<{ total: string }>(
  "SELECT COUNT(*)::text AS total FROM automation_rules WHERE tenant_id = current_setting('app.tenant_id', true)::uuid"
);
```
Apply the same fix to `taskRepository.list` COUNT at line 2289.

### Partial — bulkUpsert drops tags/country (line 891)
Update the `DO UPDATE SET` clause:
```sql
ON CONFLICT (tenant_id, phone_e164) DO UPDATE
  SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
      last_name  = COALESCE(EXCLUDED.last_name,  contacts.last_name),
      timezone   = COALESCE(EXCLUDED.timezone,   contacts.timezone),
      metadata   = jsonb_set(
                     jsonb_set(
                       contacts.metadata,
                       '{tags}',
                       COALESCE(EXCLUDED.metadata->'tags', contacts.metadata->'tags', '[]'::jsonb)
                     ),
                     '{country}',
                     COALESCE(EXCLUDED.metadata->'country', contacts.metadata->'country', 'null'::jsonb)
                   )
```

### teamRepository.update (for GAP-06)
Add after `teamRepository.create`:
```typescript
async update(tenantId: string, id: string, input: { name?: string }): Promise<Team | undefined> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<TeamRow>(
      `UPDATE teams SET name = COALESCE($2, name), updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, name, created_at`,
      [id, input.name ?? null]
    );
    return result.rows[0] ? mapTeam(result.rows[0]) : undefined;
  });
},
```

---

## Task F2: notification-worker

### BUG-01 — Automation template bypasses policy (line 664)

After the at-least-once guard and channelId resolution, add before `callMetaAdapter`:
```typescript
const contact = await contactRepository.findOrCreateByPhone(req.tenantId, req.contactPhoneE164);

if (contact.optedOut) {
  logger.warn("automation_template_opted_out", { tenantId: req.tenantId, contactId: contact.id });
  return;
}
const hasConsent = await consentRepository.hasActiveConsent(req.tenantId, contact.id);
if (!hasConsent) {
  logger.warn("automation_template_no_consent", { tenantId: req.tenantId, contactId: contact.id });
  return;
}
const settings = await whatsappSettingsRepository.getByTenant(req.tenantId);
const policyCheck = evaluateOutboundPolicy({
  hasActiveConsent: true,
  isInside24hWindow: false,
  template: { category: req.templateCategory ?? "marketing", status: "approved" } as import("@hyfib/shared-core").Template,
  requestedCategory: (req.templateCategory ?? "marketing") as import("@hyfib/shared-core").MessageCategory,
  isOptedOut: false,
  currentHourLocal: getCurrentHourInTz(contact.timezone ?? "UTC"),
  quietHours: settings?.quietHours as import("@hyfib/shared-core").QuietHoursConfig | undefined,
  frequencyCap: undefined
});
if (!policyCheck.allowed) {
  logger.warn("automation_template_policy_blocked", { tenantId: req.tenantId, reason: policyCheck.reason });
  return;
}
```

Then replace the existing `contactRepository.findOrCreateByPhone` call later in the function with a reference to the already-resolved `contact`.

Also add `AutomationTemplateRequest` needs `templateCategory` field — check the type in shared-core.

### P-01 — Auto-reply skips interactive messages (line 497)
```typescript
const interactivePayload = inbound.interactive as
  | { button_reply?: { title?: string }; list_reply?: { title?: string } }
  | undefined;
const interactiveTitle =
  interactivePayload?.button_reply?.title ?? interactivePayload?.list_reply?.title;
const text = (typeof inbound.text === "string" && inbound.text) ? inbound.text : interactiveTitle;
const matched = matchAutoReply(text, rules);
```

---

## Task F3: csv.ts

### BUG-07 — Export/import column name mismatch (line 141)
Change export header from `opted_out` to `consent` and invert the value:
```typescript
export function serializeContactsCsv(contacts: readonly ExportableContact[]): string {
  const header = "phone_e164,first_name,last_name,country,timezone,tags,consent";
  const lines = contacts.map((c) =>
    [
      csvCell(c.phoneE164),
      csvCell(c.firstName),
      csvCell(c.lastName),
      csvCell(c.country),
      csvCell(c.timezone),
      csvCell((c.tags ?? []).join("|")),
      c.optedOut ? "false" : "true"   // consent=true means NOT opted out
    ].join(",")
  );
  return [header, ...lines].join("\n");
}
```

### BUG-02 — Multipart extraction (new function)
Add before `serializeContactsCsv`:
```typescript
/**
 * Extracts the file body from a multipart/form-data buffer.
 * Returns null if the buffer is not multipart or extraction fails.
 */
export function extractMultipartFile(buffer: Buffer, boundary: string): Buffer | null {
  try {
    const sep = Buffer.from(`--${boundary}`);
    const partStart = buffer.indexOf(sep);
    if (partStart === -1) return null;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd === -1) return null;
    const fileStart = headerEnd + 4;
    const closing = Buffer.from(`\r\n--${boundary}`);
    const fileEnd = buffer.indexOf(closing, fileStart);
    return fileEnd === -1 ? buffer.subarray(fileStart) : buffer.subarray(fileStart, fileEnd);
  } catch {
    return null;
  }
}
```

---

## Task F4: api-gateway/src/index.ts

### BUG-02 — Use multipart extractor (at import endpoint, after readBinaryBody)
After the existing `csvBuffer = await readBinaryBody(...)` call, add:
```typescript
if (contentType.startsWith("multipart/form-data")) {
  const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
  if (boundaryMatch?.[1]) {
    const extracted = extractMultipartFile(csvBuffer, boundaryMatch[1]);
    if (extracted && extracted.length > 0) csvBuffer = extracted;
  }
}
```
Also import `extractMultipartFile` from `./csv.js`.

### GAP-03 — Webhook POST early channel validation
At the top of the `POST /api/v1/webhooks/meta/whatsapp` handler, after HMAC passes, add:
```typescript
const phoneNumberId = /* extract from first entry.changes[0].value.metadata.phone_number_id */
const resolved = phoneNumberId ? await resolveChannelByPhoneNumberId(phoneNumberId) : undefined;
if (!resolved) {
  sendJson(res, 200, { status: "channel_not_found" }); // return 200 to Meta (don't retry)
  logger.warn("webhook_unknown_phone_number_id", { phoneNumberId });
  return;
}
```

### GAP-06 — PATCH /teams/:id route
Add after existing teams routes:
```typescript
if (path.match(/^\/api\/v1\/teams\/[^/]+$/) && method === "PATCH") {
  if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
    sendJson(res, 403, { error: "Insufficient role" });
    return;
  }
  const teamId = path.split("/").pop()!;
  const body = await readJsonBody<{ name?: string }>(req);
  const updated = await teamRepository.update(tenantId, teamId, { name: body.name });
  if (!updated) { sendJson(res, 404, { error: "Team not found" }); return; }
  sendJson(res, 200, updated);
  return;
}
```

### GAP-09 — Remove dead tenants proxy block (~line 2589)
Delete the entire second handler block for `/api/v1/tenants` that contains `tenantServiceUrl` proxy logic.

### P-06 — GET /users role gate
Find the `GET /api/v1/users` route handler and add:
```typescript
if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
  sendJson(res, 403, { error: "Insufficient role to list users" });
  return;
}
```

---

## Task F5: web-portal/public/index.html

### BUG-04 — AI tools field names

**Campaign Draft** — Replace form + POST call:
- Remove "Goal" + "Audience Size" inputs
- Add "Objective", "Audience Description", "Offer", "Language" inputs
- Update `runCampaignDraft()` to send: `{ objective, audienceDescription, offer, tone, language }`

**Segment Summary** — Update `runSegmentSummary()`:
- Rename "Contact Count" input → still `ai-seg-count` but send as `contacts`
- Replace "Avg Engagement" with "Conversion Rate (0-100)" and "Opt-Out Rate (0-1)"
- Send: `{ segmentName, contacts: contactCount, conversionRate: cr, optOutRate: oor }`

**Lead Score** — Replace form + `runLeadScore()`:
- Remove "Contact ID", "Messages Sent", "Replies", "Days Since Last Activity"
- Add "Recency Days", "Engagement Score (0-100)", "Purchase Count", "Avg Order Value"
- Send: `{ recencyDays, engagementScore, purchaseCount, averageOrderValue }`

### BUG-06 — showCreateTenant role
Change line 3335 from:
```javascript
await POST("/tenants", { name });
```
To:
```javascript
await api("POST", "/tenants", { name }, "", "platform_owner");
```

### GAP-04 — Assignee filter in loadConvList (~line 1265)
In the `qs` array building, add:
```javascript
if (S.convFilter.assignee) qs.push("assignedUserId=" + encodeURIComponent(S.convFilter.assignee));
```

### GAP-05 — Message history load-more
Add a `before` cursor state and "Load earlier" button:
```javascript
// Add to S: msgBefore: null
// In loadMessages: append ?before=<oldest_id> if S.msgBefore set
// Add button above msgs: "Load earlier messages" → sets S.msgBefore = oldest_message_id, reloads
```

### GAP-07 — Task assignee picker
In `showAddTask()`, add after the due date field:
```javascript
'<div class="field"><label>Assignee (optional)</label><select id="task-assignee"><option value="">Unassigned</option>' +
  (S.users || []).map(u => '<option value="' + u.id + '">' + esc(u.displayName || u.email) + '</option>').join('') +
  '</select></div>'
```
And include `assigneeUserId: document.getElementById("task-assignee")?.value || undefined` in the POST body.
Pre-load users into `S.users` during `initApp()`.
