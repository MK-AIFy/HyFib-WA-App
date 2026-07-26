# Campaign Pause / Resume — Design (A2a)

**Date:** 2026-07-26
**Status:** approved
**Scope:** `services/api-gateway` + a guarded CAS helper in `packages/persistence`
**Predecessor:** `2026-07-25-campaign-claim-convergence-design.md` — pause is only
meaningful because that work made the fan-out loop converge.

---

## 1. Why this is possible now

Before the convergence fix, `campaigns.status` had exactly one reachable value
after start: `running`. Nothing wrote `completed` or `paused`, the fan-out loop
never terminated, and `running` was in practice terminal. A pause button would
have flipped a column that no consumer read.

Two things changed. `claimPendingBatch` is now a real claim, so a run drains and
reaches its natural `break`. And duplicate-suppressed dispatches now leave
`pending`, so the funnel can actually reach zero. A campaign therefore has a
an observable end, which is what makes "paused" distinguishable from "finished".

`runCampaign` already accepts `paused` in both its read-side guard
(`services/api-gateway/src/index.ts:816`) and its CAS
(`:858`). The status value has always been half-wired; nothing ever wrote it.

## 2. What A2a delivers

`POST /api/v1/campaigns/{id}/pause` and `POST /api/v1/campaigns/{id}/resume`,
plus a root-cause fix to the unguarded status write on the test-send path.

**Explicitly not in A2a:** the worker does not yet honour a pause mid-run (A2b),
and there is no cancel (A2c). See §7.

## 3. Architecture — three layers, chosen because of how this codebase is tested

`services/api-gateway` has **no route-level tests**. All 155 of its tests are
pure-function unit tests against extracted modules (`campaign.js`,
`authorization.js`, `validation.js`, `rate-limit.js`); nothing constructs
`createGatewayHandler` or drives an HTTP request. Every route is untested glue.

Putting transition logic inline in the router would therefore make it
permanently untestable. The design pushes each decidable piece out to a layer
that has a real test home.

### Layer 1 — pure transition policy

`services/api-gateway/src/campaign.ts` (already exists, already pure, already has
`test/campaign.test.js`). Follows the documented precedent of
`filterSendableContacts`: "Pure (no I/O) so it is unit-testable."

```ts
export type CampaignAction = "pause" | "resume";

export const CAMPAIGN_TRANSITIONS: Record<CampaignAction, { from: readonly string[]; to: string }> = {
  pause: { from: ["running", "scheduled"], to: "paused" },
  resume: { from: ["paused"], to: "running" }
};

export function canTransition(current: string, action: CampaignAction): boolean;
export function transitionConflict(current: string, action: CampaignAction): string;
```

`transitionConflict` returns the operator-facing 409 message, mirroring the
existing phrasing at `:817` (`Campaign is already ${status}`).

**Pausing a `scheduled` campaign is deliberately allowed.** It de-schedules for
free: `due_scheduled_campaigns` (`infra/postgres/init/011_scheduler_functions.sql:5`)
filters `c.status = 'scheduled'`, so a paused campaign becomes invisible to the
scheduler. `scheduled_at` survives, because only the scheduler's own claim NULLs
it (`index.ts:1222`). Resume returns it to `running`, not to `scheduled` — a
resumed campaign runs now rather than waiting on a time that has probably passed.

### Layer 2 — guarded CAS in persistence

```ts
campaignRepository.transition(
  tenantId: string,
  id: string,
  from: readonly string[],
  to: string,
  client?: QueryClient
): Promise<boolean>
```

```sql
UPDATE campaigns SET status = $3 WHERE id = $1 AND status = ANY($2) RETURNING id
```

Returns whether a row changed. Three reasons it looks like this:

- **Compare-and-swap, not read-then-write.** Two concurrent pause requests, or a
  pause racing the scheduler's `scheduled → running` claim, must not both win.
  Same reasoning as the comment at `index.ts:853-854`.
- **`rowCount` is checked, never assumed.** Under FORCE RLS, an `UPDATE campaigns`
  issued outside `withTenant` matches zero rows and raises no error. Silent
  no-op is the most likely way this feature breaks in production.
- **The optional `client` is load-bearing for resume.** Resume must flip the
  status *and* enqueue `CampaignRunRequested` in one transaction — otherwise a
  crash between them leaves a campaign `running` with no worker ever notified.
  `runCampaign` already depends on exactly this atomicity (`:856-880`). The
  optional-client shape mirrors `outboxRepository.enqueue`, the existing
  precedent for a repository method participating in a caller's transaction.

The existing dead `campaignRepository.setStatus` (`repositories.ts:784`,
unconditional, `void`, zero callers) is **left untouched** — project rule 1. It
is not extended, because an unguarded status write is exactly what this design
exists to avoid.

### Layer 3 — routes (thin glue)

Placed in the `// ─── Campaigns ───` section between `/run` (ends `:2841`) and
`/report` (`:2844`), matching the verb-suffix POST idiom of the sibling routes.

| Route | Success | Body |
|---|---|---|
| `POST /{id}/pause` | `200` | `{ status: "paused", campaignId, pendingRecipients }` |
| `POST /{id}/resume` | `202` | `{ status: "resumed", campaignId }` |

Failure modes, in check order — identical for both routes:

| Condition | Status | Body |
|---|---|---|
| Role not in `platform_owner \| tenant_admin \| marketing_manager` | 403 | `{ error: "Insufficient role to pause campaigns" }` |
| Malformed id | 400 | `{ error: "Invalid campaign id" }` |
| Unknown campaign | 404 | `{ error: "Campaign not found" }` |
| Illegal source status | 409 | `{ error: transitionConflict(...) }` |
| CAS lost to a concurrent writer | 409 | `{ error: "Campaign status changed concurrently" }` |

Both 409s are required and distinct — the pre-check produces a good operator
message, the CAS closes the race. `/run` already carries this same pair
(`:817` and `:883`).

**`pendingRecipients`** comes from `campaignRecipientRepository.funnelCounts`
(`repositories.ts:2457`, returns `Record<string, number>`). It exists so an
operator can distinguish a real stop from a no-op: pausing a campaign that
finished weeks ago returns `pendingRecipients: 0`. Without it, pause looks
identical whether it stopped 9,000 sends or nothing at all.

**Resume's event payload** is byte-for-byte the one `runCampaign` builds
(`:863-878`): `campaignId, tenantId, channelId, templateName, templateLanguage,
templateCategory, templateStatus, variableMapping, quietHours, frequencyCap,
ratePerMinute`. Resume therefore re-reads the template and the active channel
(`channelRepository.firstActive`) before enqueueing, and 409s if no active
channel exists — the same guard `runCampaign` applies at `:842`.

**Resume does not touch `campaign_recipients`.** This is the approved
frozen-audience semantic: the campaign targets exactly who it targeted at start.
`runCampaign` re-resolves the segment and re-runs `insertBatch` (`:847`), so
resuming through `/run` would silently add contacts who joined the segment while
it was paused. `/run` keeps that behaviour for its own callers; `/resume` is the
predictable one.

### Rate limiting

`classifyRoute` (`services/api-gateway/src/rate-limit.ts:70-95`) matches
`CAMPAIGN_RUN_PATTERN`, anchored `^/api/v1/campaigns/{uuid}/run$`. `/pause` and
`/resume` do not match it and fall through to `MUTATING_METHODS` → `write`
(120/min). **This is deliberate and must be pinned by a test.** Classifying pause
as `expensive` (10/min) would throttle an operator trying to stop a bad send —
precisely when they are clicking fastest.

## 4. The root-cause fix — the unguarded write at `:786`

`dispatchCampaign` (the single-number test send) runs:

```sql
UPDATE campaigns SET status = 'running' WHERE id = $1
```

with no guard and no `RETURNING` check. A single test send therefore **silently
resurrects a paused campaign to `running`**, and the operator gets no signal.
Without fixing this, pause is not durable and A2c's cancel would not be terminal.

The guard restricts it to statuses from which promoting to `running` is
meaningful:

```sql
UPDATE campaigns SET status = 'running' WHERE id = $1 AND status IN ('draft', 'scheduled', 'running')
```

A test send against a paused campaign now leaves the status alone. It still
sends — that is the point of a test send, and blocking it is a product decision
not being made here. Only the unintended status side-effect is removed.

This is the same file and module as the new routes, so project rule 3 holds
while rule 5 is satisfied.

## 5. Testing

| Layer | Where | What |
|---|---|---|
| Transition policy | `services/api-gateway/test/campaign.test.js` | every legal and illegal `(status, action)` pair; conflict message text |
| Rate-limit class | `services/api-gateway/test/rate-limit.test.js` | `/pause` and `/resume` classify `write`, not `expensive` |
| Guarded CAS | `packages/persistence/test/campaigns.integration.test.js` | applies from a legal status; no-ops from an illegal one; returns false rather than throwing; tenant-isolated; participates in a caller's transaction and rolls back with it |

The routes themselves stay untested, consistent with every other route in this
service. The three tested layers are where all the decisions live; the router
only sequences them.

`campaignRepository.transition`'s guard can **only** be proven in the persistence
integration suite — it is SQL. Note that suite runs solely under `RUN_DB_TESTS=1`;
a plain `pnpm test` reports those tests as skipped and stays green vacuously.

## 6. Validation

```bash
pnpm build && pnpm lint && pnpm format:check && pnpm test
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

## 7. Known limitations of A2a

1. **Pause does not stop an in-flight fan-out.** A2a is gateway-only: it prevents
   future starts and de-schedules, but `handleCampaignRun` re-reads nothing and
   keeps claiming batches until the run drains. A2b adds the abort check. This is
   deliberately *not* encoded in the API response, because it is temporary and the
   contract would become wrong.
2. **Nothing writes `completed` yet.** Pause remains offerable on a campaign that
   finished long ago; the `pendingRecipients: 0` in the response is the only
   signal. A2b adds the first `completed` writer, CAS'd `WHERE status = 'running'`
   so it cannot clobber a concurrent pause.
3. **No SSE event.** The SPA has `staleTime: 15_000` and no `refetchInterval`, so
   a status change is invisible until remount. Out of scope.
4. **Head-of-line blocking is untouched.** A paused campaign's already-enqueued
   outbox rows still publish, and a long fan-out still stalls the relay.
