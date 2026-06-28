# A3 Findings: Contacts + Consent

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| List contacts (GET /contacts?q=&offset=) | PASS | Route exists; calls `contactRepository.search`; search is parameterized with ILIKE via positional params; returns `{items, total, limit, offset}` | api-gateway/src/index.ts:1508 |
| Add contact — RBAC (analyst → 403) | PASS | `canCreateContact` allows only `platform_owner`, `tenant_admin`, `marketing_manager`; analyst role absent; 403 returned correctly | api-gateway/src/authorization.ts:5, index.ts:1516 |
| Add contact — body validation | PASS | E.164 regex enforced; firstName/lastName/country/timezone/tags each length-capped; tags array max 50 items | api-gateway/src/index.ts:1521-1550 |
| Get contact profile (GET /contacts/:id) | PARTIAL | Returns contact object (id, phone, firstName, lastName, optedOut, tags, customFields, timezone) but does NOT include notes or consent status; UI loads notes separately via `/contacts/:id/notes` | api-gateway/src/index.ts:1837-1849 |
| Grant consent (POST /contacts/:id/consent) | BUG | `consentRepository.grant` does a bare INSERT with no ON CONFLICT — calling it twice inserts duplicate rows. The `consent_records` table has no UNIQUE constraint on (contact_id, channel, revoked_at); both calls succeed and both rows remain active. Only the CSV-import path uses ON CONFLICT DO NOTHING | repositories.ts:1016-1022, 001_schema.sql:70-81 |
| Grant consent — also clears optedOut | PASS | Route calls `contactRepository.setOptedOut(tenantId, contactId, false)` after granting consent | api-gateway/src/index.ts:1670 |
| Opt-out (POST /contacts/:id/opt-out) | PASS | Calls `consentRepository.revoke` (sets `revoked_at`) + `setOptedOut(true)` + emits `ComplianceOptOutEvent`; RBAC restricts to owner/admin/manager/support/compliance_auditor | api-gateway/src/index.ts:1681-1719 |
| Import CSV — phone_e164 validation | PASS | `parseCsv` rejects rows missing phone; validates E.164 regex `/^\+[1-9]\d{7,14}$/`; also accepts `phone` column alias | csv.ts:78-99 |
| Import CSV — duplicate upsert | PARTIAL | `bulkUpsert` upserts by phone; updates `first_name`, `last_name`, `timezone` on conflict. However, the `metadata` column (country, tags, optedOut) is NOT updated on conflict — existing contacts keep their old tags/country even if CSV specifies new ones | repositories.ts:891-895 |
| Import CSV — optedOut reset on upsert | BUG | `bulkUpsert` always constructs `metadata = { optedOut: false, ... }` for the VALUES clause but the DO UPDATE only sets `first_name`, `last_name`, `timezone` — so `optedOut` is NOT reset for existing contacts. However this is actually safe behavior (preserves opted-out state). But `tags` and `country` from the CSV are also silently dropped for existing contacts, which is a data-loss gap | repositories.ts:882-895 |
| Import CSV — content-type handling | GAP | Import endpoint accepts any body, uses `readBinaryBody` not multipart parser; UI sends via `FormData` (multipart). The `content-type` header parse for filename extraction uses a fragile string split on `filename=` which breaks for most real multipart headers | api-gateway/src/index.ts:1596-1625 |
| Export CSV — Content-Type | PASS | Sets `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="contacts.csv"`, `X-Export-Count`, `X-Export-Truncated` | api-gateway/src/index.ts:1566-1588 |
| Export CSV — RBAC | PASS | Restricted to `platform_owner`, `tenant_admin`, `marketing_manager` | api-gateway/src/index.ts:1567 |
| Export CSV header vs import header mismatch | BUG | `serializeContactsCsv` emits header `opted_out` but `parseCsv` expects `consent` column (not `opted_out`). A round-trip export → re-import will not restore consent state because the exported column name is not recognized | csv.ts:141 vs csv.ts:76 |
| Contact notes (GET /contacts/:id/notes) | PASS | Route exists; RBAC allows owner/admin/manager/sales/support; `contactNoteRepository.list` is parameterized; limited to 200 rows | api-gateway/src/index.ts:1722-1759 |
| Contact notes (POST /contacts/:id/notes) | PASS | `boundedText` enforces 4096-char limit; audited; author linked via `asActorUuid` | api-gateway/src/index.ts:1737-1756 |
| Tags (GET /api/v1/tags) | PASS | Route exists; no RBAC restriction on GET (any authenticated user); returns full tag catalog | api-gateway/src/index.ts:1853-1856 |
| Tags used in UI for filtering/display | PARTIAL | Tags rendered as badges in contact list and contact profile. No tag-filter dropdown in the contacts list UI — only free-text search. Segments support tag filtering but contacts list does not surface `?tag=` filter in the UI | index.html:1738-1740 |
| Inbound STOP → automatic opt-out | PASS | `isOptOutKeyword` matches "stop", "unsubscribe", "cancel", "end", "quit", "stopall", "optout", "opt-out" (case-insensitive via `normalize`); triggers `consentRepository.revoke` + `setOptedOut(true)` + `ComplianceOptOutEvent`; auto-reply is suppressed after STOP | notification-worker/src/index.ts:474-484, shared-core/src/compliance.ts:4 |
| Inbound START → re-subscription | PASS | `isOptInKeyword` matches "start", "unstop", "subscribe", "yes", "optin", "opt-in"; triggers `consentRepository.grant` + `setOptedOut(false)` | notification-worker/src/index.ts:487-492 |
| Inbound STOP/START case-insensitive | PASS | `normalize()` lowercases and strips non-alpha chars before set lookup | shared-core/src/compliance.ts:7-11 |
| Contact profile — includes tags | PASS | `mapContact` returns `tags: row.metadata?.tags ?? []`; tags displayed in profile modal | repositories.ts:667, index.html:1889 |
| Contact profile — does not include consent status | GAP | `GET /contacts/:id` response does not include `hasConsent` or `consentGrantedAt`; UI cannot show "this contact has given consent" without a separate API call (no such endpoint exposed) | api-gateway/src/index.ts:1843-1849 |
| SQL injection — contact search | PASS | All search params use positional placeholders (`$1`, `$2`, etc.); ILIKE wildcard is added in application code (`%${opts.query}%`) then passed as a parameter — safe | repositories.ts:720-722 |
| RLS on contacts | PASS | `contacts`, `consent_records` have RLS enabled and FORCE RLS; queries run inside `withTenant` which sets tenant context | 001_schema.sql:159-200 |
| Audit trail | PASS | All write operations (create contact, import, export, consent, opt-out, note) emit audit events via `auditRepository.add` | api-gateway/src/index.ts:1552, 1575, 1634, 1671, 1712, 1750 |

---

## Issues (GAP / PARTIAL / BUG only)

### Grant Consent — Not Idempotent (BUG)

**File:** `packages/persistence/src/repositories.ts:1016`  
**Detail:** `consentRepository.grant` does a plain `INSERT INTO consent_records` with no `ON CONFLICT` clause. The `consent_records` table has no UNIQUE constraint on `(contact_id, channel)` for active (non-revoked) rows. Calling `POST /contacts/:id/consent` twice creates two identical active consent records. The `hasActiveConsent` check still returns true (correct), but the duplicate rows accumulate indefinitely and degrade query performance over time.  
**Impact:** Data pollution; duplicate rows in compliance audit trail; `hasConsentBatch` is correct but the table grows unboundedly for repeated consent grants.  
**Fix:** Add `UNIQUE (tenant_id, contact_id, channel)` where `revoked_at IS NULL` (partial index) and add `ON CONFLICT DO NOTHING` to the grant INSERT, mirroring the csv_import path at line 907.

---

### Import CSV — Tags and Country Silently Dropped for Existing Contacts (PARTIAL/BUG)

**File:** `packages/persistence/src/repositories.ts:891`  
**Detail:** The `DO UPDATE` clause in `bulkUpsert` only updates `first_name`, `last_name`, and `timezone`. The `metadata` column (which stores `tags`, `country`, `optedOut`) is entirely excluded from the update. If a CSV re-import includes new tags or a corrected country for an existing contact, those values are silently ignored.  
**Impact:** Operators cannot bulk-update tags or country via CSV re-import. Expected behavior (additive tag merge or country update) does not occur. No error is returned; the import reports the row as "updated" even though the metadata fields were not changed.  
**Fix:** The DO UPDATE should merge tags (array union) and update country when provided, e.g. `metadata = contacts.metadata || EXCLUDED.metadata` or a more targeted jsonb merge.

---

### Export CSV Header Mismatch with Import (BUG)

**File:** `services/api-gateway/src/csv.ts:141` (export) vs `csv.ts:76` (import)  
**Detail:** `serializeContactsCsv` produces a CSV with header `opted_out` (boolean). But `parseCsv` does not recognize `opted_out` as a consent column — it looks for `consent` (truthy string). A round-trip (export then re-import) will produce a file that cannot restore consent state. The `opted_out=false` column is not interpreted as a consent grant; there is no mapping from `opted_out=true` to opt-out the contact on import.  
**Impact:** Export-then-reimport workflow is broken for consent propagation. A user who exports contacts and re-imports the same file will silently lose all consent records if they expected the export to be re-importable.  
**Fix:** Either rename the export header to `consent` and invert the boolean (true = consented, false = opted-out), or add `opted_out` as a recognized import column that calls `setOptedOut`.

---

### Import CSV — Multipart Body Not Properly Parsed (GAP)

**File:** `services/api-gateway/src/index.ts:1596`  
**Detail:** The import endpoint calls `readBinaryBody(req, CSV_UPLOAD_MAX_BYTES)` which reads the raw request body. The UI sends the CSV via `FormData` (multipart/form-data with boundary). This means the server receives the raw multipart body including the boundary headers, content-disposition, and boundary markers as part of the buffer passed to `parseCsv`. The CSV parser's first "line" would be the multipart boundary (`------FormBoundary...`), which is not a valid CSV header, causing the import to fail with `CSV must have a "phone_e164" or "phone" column`.  
**Impact:** The import UI button (`Import CSV`) is likely broken in production unless the browser sends raw CSV without FormData wrapping. The drag-and-drop UI path uses `FormData.append("file", fi.files[0])` which produces a multipart body.  
**Fix:** Implement multipart parsing (e.g. using a boundary parser) or change the UI to send raw CSV bytes with `Content-Type: text/csv`.

---

### Contact Profile — No Consent Status Exposed (GAP)

**File:** `services/api-gateway/src/index.ts:1843`  
**Detail:** `GET /contacts/:id` returns the contact object but does not include whether the contact has active consent (`hasConsent: boolean`). The UI contact profile shows opt-out status but cannot display consent status without a separate query. There is no `GET /contacts/:id/consent` endpoint.  
**Impact:** Operators cannot see at a glance whether a contact has given consent vs. just not being opted out. Consent and optedOut are separate states — a contact can be not opted-out but still lack consent, which would block template sends.  
**Fix:** Add `hasConsent` field to `GET /contacts/:id` response by joining `consent_records`, or add a `GET /contacts/:id/consent` endpoint.

---

### Tags Not Used as Filter in Contacts List UI (PARTIAL)

**File:** `services/web-portal/public/index.html:1664`  
**Detail:** The contacts list supports `?tag=` query parameter at the API level (`contactRepository.search` accepts `tag` filter), but the UI only exposes a free-text search box. There is no tag-filter dropdown or checkbox in the contacts page. Tags are displayed but cannot be used to filter the contact list from the UI.  
**Impact:** UX gap — operators cannot click a tag badge to filter by it, nor select a tag from a dropdown. The backend capability exists but is not surfaced.  
**Fix:** Add a tag filter control (dropdown populated from `GET /api/v1/tags`) to the contacts list page that appends `&tag=<name>` to the loadContacts request.
