# Template Lifecycle (Roadmap A3 / Gap G3) — Design

**Date:** 2026-07-29
**Parent:** `2026-07-23-wati-gap-analysis-and-roadmap.md` — Phase A, item A3.
**Problem:** Locally created templates sit `pending` forever — there is no
submit-to-Meta flow, no edit, and no delete. Sync is pull-only. Wati parity
requires the full lifecycle: create → submit → (Meta review) → edit → delete.

## Scope

Backend + API + tests (UI follows the PR #12 precedent: backend first; the
52-line read-only TemplatesPage gains buttons in a later slice).

1. **Submit to Meta** — `POST /api/v1/templates/:id/submit` `{channelId}`
2. **Edit** — `PATCH /api/v1/templates/:id` `{category?, body?, channelId?}`
3. **Delete** — `DELETE /api/v1/templates/:id?channelId=…`

Out of scope: rejection-reason capture on sync, rich component builder
(header/footer/buttons — body-only components for now, matching the existing
`extractTemplateBody` model), per-language bulk delete UI.

## Data model (migration `024_template_lifecycle.sql`)

```sql
ALTER TABLE templates ADD COLUMN IF NOT EXISTS meta_template_id TEXT;
```

- `meta_template_id IS NULL` = never submitted (local draft, status `pending`).
- Set on successful submit; also captured on sync pull (Meta `id` field added
  to the sync `fields` list) so pre-existing remote templates get linked.
- Status enum unchanged (`approved|rejected|pending|paused`) — "submitted-ness"
  is `meta_template_id` presence, not a new status (no type ripple).

## Layers (per-module commits, each gated on build+lint+test)

### 1. persistence + shared-core
- `Template.metaTemplateId?: string | null` (additive).
- `templateRepository.update(tenantId, id, {category?, body?, status?})` —
  dynamic SET, RETURNING mapped row, `withTenant`-scoped (RLS watch-out).
- `templateRepository.delete(tenantId, id)` — returns boolean; FK violations
  (campaigns.template_id) propagate for the gateway to map to 409.
- `templateRepository.markSubmitted(tenantId, id, metaTemplateId)` — sets
  `meta_template_id` + `status='pending'`.
- `upsertFromMeta` gains optional `metaTemplateId`; `COALESCE` keeps existing.
- DB-gated integration tests (RUN_DB_TESTS pattern).

### 2. meta-adapter
- `graphRequest` method union widened: `"GET" | "POST" | "DELETE"`.
- Pure builder in graph-messages: `buildTemplateCreateBody({name, language,
  category, bodyText})` → `{name, language, category: UPPER, components:
  [{type: "BODY", text}]}` (+ unit tests).
- Direct fns (in-process seam, `MetaDispatchResult` shape):
  - `submitTemplateDirect({wabaId, accessToken?, name, language, category,
    bodyText}, requestId)` — POST `/{wabaId}/message_templates`; success maps
    `{id, status}` via `mapMetaTemplateStatus`.
  - `editTemplateDirect({metaTemplateId, accessToken?, category?, bodyText?},
    requestId)` — POST `/{metaTemplateId}`; requires ≥1 change field.
  - `deleteTemplateDirect({wabaId, accessToken?, name, metaTemplateId?},
    requestId)` — DELETE `/{wabaId}/message_templates?name=…&hsm_id=…`.
- Standalone HTTP routes (BOTH paths rule from PR #12 — every op needs the
  direct fn AND an HTTP route, identical wire keys):
  - `POST /internal/v1/whatsapp/templates` → submit
  - `POST /internal/v1/whatsapp/templates/edit` → edit
  - `POST /internal/v1/whatsapp/templates/delete` → delete
  - internal-secret guard + `x-access-token` header, same as the GET route;
    http-routes test additions prove registration (400-not-404).

### 3. api-gateway
- Single proxy seam `TemplateAdminProxy` (discriminated op union
  submit/edit/delete) following the UploadMediaProxy pattern: exported type,
  `default…Proxy` HTTP fetch to the three routes, module `let`, GatewayDeps
  `proxyTemplateAdmin`, reset-to-default when deps omit it.
- Routes (roles: platform_owner/tenant_admin/marketing_manager — same as
  create; all audited; TemplateStatusUpdated published on status changes):
  - **submit**: 404 unknown id; 422 `category=service` (not a Meta template
    category); 409 already `approved`; 404 unknown channel; 422 channel has no
    access token; proxy failure → 502 (`template_submit_failed`) / 503
    unavailable; success → `markSubmitted` + 200 with updated template.
  - **edit**: bounds identical to create (category enum, body ≤ 1024); ≥1
    field required; if `metaTemplateId` set → `channelId` required (422) and
    Meta edit runs FIRST — on failure 502 and NO local change (no drift);
    successful Meta edit resets status to `pending` (Meta re-reviews); local-
    only templates just update.
  - **delete**: if `metaTemplateId` set → `channelId` required; Meta delete
    first, failure → 502 abort; local FK violation (23503) → 409
    `template_in_use`; success → 200 `{deleted: true}`.
- Gateway handler tests with injected proxy.

### 4. app-server
- Wire `proxyTemplateAdmin` to the direct fns (uploadMediaDirect precedent).

## Error-mapping contract

Proxy/direct results reuse the media-upload mapping style: Graph 4xx →
502 with the Graph error detail (except auth misconfig cases surfaced as
422 before any network call), fetch/circuit failures → 503
`meta_adapter_unavailable`. Meta is always mutated BEFORE local state; local
state changes only after Meta success (no silent drift).

## Testing

- Unit: builders, direct-fn validation, error mapping, gateway route guards.
- Integration (DB-gated): repo update/delete/markSubmitted/upsert metaId.
- http-routes: 3 new routes registered (400 not 404).
- Live smoke: submit path returns structured 502 locally (no Meta creds) —
  proves wiring, matching the media-upload verification precedent.
