# Campaign fan-out convergence — make `claimPendingBatch` actually claim

**Date:** 2026-07-25
**Status:** Approved design, pending implementation plan
**Iteration:** Phase A prerequisite (blocks A2 campaign pause/cancel)
**Module:** `packages/persistence` (+ its schema in `infra/postgres/init`)

---

## 1. Problem

A campaign run cannot converge in the topology HyFib actually deploys, and while
one runs, the **entire system's outbox relay is wedged**.

### 1.1 Evidence chain

Every link verified by direct file read at commit `0417145`:

| # | Fact | Location |
|---|------|----------|
| 1 | `app-server` is the only application container | `docker-compose.yml:21` |
| 2 | `EVENT_BUS=memory` in both shipped deployments | `docker-compose.yml:31`, `deploy/oracle/setup-vm.sh:112` |
| 3 | One `eventBus` instance serves the gateway, the worker consumers, and the relay — one process | `services/app-server/src/main.ts:110`, `:66`, `:179`, `:181` |
| 4 | `InMemoryEventBus.publish` does `await Promise.all(handlers…)` — publishing **blocks until the handler finishes** | `packages/event-bus/src/index.ts:44` |
| 5 | The relay publishes rows **sequentially with `await`**, under a `if (running) return` re-entrancy guard | `services/api-gateway/src/outbox-relay.ts:42-49`, `services/api-gateway/src/index.ts:1149` |
| 6 | `claimPendingBatch` is a **pure SELECT**. Its `FOR UPDATE SKIP LOCKED` locks are released by the enclosing `withTenant` commit before the caller touches a row. The doc comment claims "cursor-based pagination"; there is no cursor | `packages/persistence/src/repositories.ts:2455-2468` |
| 7 | An approved recipient is only `toEnqueue.push(...)` + `processed++`. **The recipient row is never touched.** Rows leave `pending` solely in `handleDispatch` | `services/notification-worker/src/index.ts:466-480`, `:296-302` |

**Therefore:** the relay tick that delivers `CampaignRunRequested` is blocked
*inside* `handleCampaignRun` for the whole run. The `CampaignDispatchRequested`
rows that run is writing can never be relayed, so no recipient ever leaves
`pending`, so `claimPendingBatch` returns **the same 50 people** on every one of
its 10,000 iterations.

### 1.2 Blast radius

- **Redis up:** ~500,000 paced `acquireRateLimit` acquisitions. At the default
  60/min that is roughly six days with the global relay frozen — not just
  campaigns, but every outbox-delivered event in the system.
- **Redis down:** `acquireRateLimit(...).catch(() => undefined)`
  (`services/notification-worker/src/index.ts:464`) swallows the failure, the
  loop spins at full speed, and ~500k duplicate outbox rows are written near
  instantly.

Duplicate *sends* are still prevented downstream by `campaignSendLog.tryClaim`
(`packages/persistence/src/repositories.ts:1990`). The damage is to the outbox,
the rate budget, and relay availability — not to recipients' inboxes.

### 1.3 This is unintended, not a design

Two comments assert invariants that do not exist:

- `services/notification-worker/src/index.ts:365-366` — "claimPendingBatch
  advisory-locks rows so a restarted worker won't re-dispatch the same
  contacts." `pg_advisory_lock` appears nowhere in the repository.
- `services/notification-worker/src/index.ts:1082-1085` — "the synchronous
  in-memory bus + idempotent claimPendingBatch make re-processing safe." False
  on both halves.

Both should be corrected as part of this work.

### 1.4 Verification status

The mechanism was proven by code reading across all seven links, then
**reproduced against a live PostgreSQL** during implementation. Two successive
`claimPendingBatch` calls over 10 pending recipients returned the identical
four rows, and the convergence loop tripped its iteration guard — the exact
non-convergence predicted above. Both are now permanent regression tests (§5
cases 1 and 2).

---

## 2. Root cause

**`claimPendingBatch` does not claim.** A function whose contract its callers
depend on — "give me the next batch, and don't give it to anyone else" — is
implemented as a plain read. Everything in §1.2 follows from that single defect.

Fixing it makes the loop's existing exit condition
(`if (batch.length === 0) break`, `services/notification-worker/src/index.ts:377`)
start firing. **No notification-worker change is required for convergence.**

---

## 3. Design

### 3.1 Schema — `infra/postgres/init/021_campaign_recipient_claim.sql`

```sql
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_claim
  ON campaign_recipients(campaign_id, created_at) WHERE status = 'pending';
```

Rationale:

- **Nullable timestamp as state** is the house idiom — see
  `infra/postgres/init/019_conversation_archive_pin.sql`, whose columns
  "double as an audit trail for free".
- **Additive and idempotent**, matching the `IF NOT EXISTS` style already used
  throughout `006_marketing.sql`.
- **Backward compatible (Rule #7):** existing rows read as unclaimed, so
  campaigns already in flight during a deploy continue to work.
- **No `CHECK` constraint to extend** — `campaign_recipients.status` is plain
  `TEXT` with no constraint (`006_marketing.sql:45-49`).
- **No TypeScript union changes**, so there is no ripple into
  `packages/shared-core`, the hardcoded `tenantAnalytics` buckets
  (`packages/persistence/src/repositories.ts:2080-2086`), or
  `services/web-app/src/pages/CampaignsPage.tsx`.
- The partial index serves the claim's `status='pending'` filter and its
  `ORDER BY created_at`. The existing
  `idx_campaign_recipients_campaign_status(tenant_id, campaign_id, status)`
  stays; it serves the funnel-count queries.

Migrations are tracked by **filename only, with no checksums**
(`scripts/migrate.sh:30`, `:43-48`) — once `021` ships it can never be edited.
It is deliberately kept to two statements for that reason.

### 3.2 The claim — `packages/persistence/src/repositories.ts`

`claimPendingBatch` becomes a real claim:

```sql
WITH claimed AS MATERIALIZED (
  SELECT c.id FROM campaign_recipients c
  WHERE c.campaign_id = $1
    AND c.status = 'pending'
    AND (c.claimed_at IS NULL OR c.claimed_at < now() - make_interval(mins => $3::int))
  ORDER BY c.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE campaign_recipients r
SET claimed_at = now()
FROM claimed
WHERE r.id = claimed.id
RETURNING r.id, r.tenant_id, r.campaign_id, r.contact_id, r.phone_e164, r.status,
          r.external_message_id, r.error, r.skip_reason,
          r.sent_at, r.delivered_at, r.read_at, r.created_at;
```

> **Amended during implementation.** This section originally specified the
> `WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT …)` shape, copied from
> `outbox_claim` (`infra/postgres/init/015_outbox_durability.sql:27-40`). That
> shape is **not safe here** and the integration test caught it: the planner is
> free to treat the subquery as a semi-join and re-execute the locking subplan
> once per candidate row, and because `FOR UPDATE SKIP LOCKED` yields different
> rows on each execution, every outer row finds a match. Measured against the
> real schema, a `LIMIT 4` claim over 10 pending rows updated **all 10**
> (`Nested Loop Semi Join … loops=10`). `MATERIALIZED` forces single evaluation
> and is load-bearing — do not remove it.
>
> **Latent risk recorded, not a live bug:** `outbox_claim` uses the same
> unmaterialised shape. It was tested directly during this work and does respect
> its limit today (`outbox_claim(4)` over 12 pending rows returned exactly 4),
> because `idx_outbox_pending_next` gives it a plan that materialises. But that
> is a planner choice, not a structural guarantee, and it could flip with
> different statistics or data volume. See §6 item 9.

- **No `SECURITY DEFINER` needed.** Unlike `outbox_events`,
  `campaign_recipients` is reached through `withTenant`, so the RLS policy
  (`006_marketing.sql:65-70`) scopes both the CTE and the update. The DB
  identity `hyfib_app` holds `UPDATE` on all public tables
  (`002_app_role.sh:36`), and FORCE RLS applies identically in gateway and
  worker.
- **The `RETURNING` list is the existing column set** — `claimed_at` is
  deliberately excluded — so `CampaignRecipientRow`, `mapRecipient`, and the
  exported `CampaignRecipient` type are all unchanged.

**Signature (Rules #6, #7):**

```ts
async claimPendingBatch(
  tenantId: string,
  campaignId: string,
  batchSize: number,
  staleClaimMinutes = 15
): Promise<CampaignRecipient[]>
```

The defaulted fourth parameter keeps the existing call site
(`services/notification-worker/src/index.ts:376`) compiling untouched, so this
iteration stays within one module (Rule #3) while leaving an injection seam for
config wiring later. The house config pattern when that happens is
`parseNumber("CAMPAIGN_CLAIM_STALE_MINUTES", env.CAMPAIGN_CLAIM_STALE_MINUTES, 15)`
in `packages/config/src/index.ts:124-140`.

### 3.3 Why 15 minutes, and what happens if it is wrong

The reclaim interval must exceed one batch's wall time. Because pacing sits
*inside* the fan-out (`acquireRateLimit`, worker `:464`), batch wall time is
`batchSize ÷ ratePerMinute`: ~50s at the default 60/min, but **50 minutes** at
`ratePerMinute=1`. The outbox's 2-minute constant would therefore be badly wrong
here, and no fixed value is universally safe.

The failure mode is bounded and worth stating plainly: a prematurely reclaimed
row produces a **duplicate outbox row, not a duplicate send**, because
`campaignSendLog.tryClaim` is the exactly-once guard at send time
(`packages/persistence/src/repositories.ts:1990`, PK
`(tenant_id, campaign_id, phone_e164)` from `003_functions.sql:10`). 15 minutes
covers `ratePerMinute >= 4` with margin; below that, operators pay in redundant
outbox rows, not in duplicate messages to contacts.

### 3.4 Stale comments to correct

Delete or rewrite the two false claims at
`services/notification-worker/src/index.ts:365-366` and `:1082-1085` (§1.3).

These touch a second file, so the Rule #3 position is stated explicitly rather
than left to judgement: they are **comment-only edits with zero behavioural and
zero compiled-output change**, included because leaving comments that assert
non-existent safety invariants (advisory locks, idempotent claims) actively
misleads the next reader of exactly the code this spec changes. No executable
line in `notification-worker` is modified in this iteration.

---

## 4. What this does **not** fix

**Head-of-line blocking remains.** After this change the loop terminates
correctly and claims each recipient exactly once, but the relay is still wedged
for the duration of the run, because pacing happens inside the fan-out. A
10,000-recipient campaign at 60/min still freezes the global outbox relay for
roughly three hours.

That is an architectural property of `EVENT_BUS=memory` + a synchronous bus +
a sequential relay, not something this change addresses. Options for a later
iteration: move pacing out of the fan-out; bound work per invocation with a
continuation event; or declare `memory` mode unsupported for campaigns and
require RabbitMQ. **This spec deliberately does not choose among them.**

Also unchanged: nothing anywhere writes `'completed'` or `'paused'`
(`'running'` is the de-facto terminal status), which is the subject of the
follow-on pause/cancel iteration.

---

## 5. Testing (Rule #8)

New file: `packages/persistence/test/campaigns.integration.test.js`, guarded by
`const skip = !process.env.RUN_DB_TESTS`, with `test.after(closePool)` — the
established pattern for DB-backed suites. This is the one suite CI's
`integration-test` job actually executes (`.github/workflows/ci.yml` runs
`pnpm --filter @hyfib/persistence test` with `RUN_DB_TESTS=1` against
postgres:16-alpine), so it will not be dead weight.

Cases, written test-first:

1. **Claim excludes claimed rows.** Two sequential `claimPendingBatch` calls
   over 100 pending recipients return disjoint sets of 50.
2. **Convergence.** Claiming repeatedly over N recipients eventually returns an
   empty batch. This is the executable regression proof for §1 — it fails
   against today's SELECT-only implementation, which returns the same rows
   forever.
3. **Concurrency.** Two overlapping claimers get disjoint sets and never the
   same row (`FOR UPDATE SKIP LOCKED`).
4. **Stale reclaim.** A row whose `claimed_at` is older than
   `staleClaimMinutes` is returned again; one inside the window is not.
5. **Tenant isolation.** A claim under tenant A never returns tenant B's rows,
   proving the RLS policy still applies through the new `UPDATE`.
6. **Non-pending rows are never claimed** — `sent` / `failed` /
   `policy_skipped` rows stay untouched.

Note that backend test files are neither linted (`eslint.config.mjs:7` ignores
`**/*.test.js`) nor typechecked, so assertions should be on recorded values
rather than on a fake having been invoked.

### Validation gate (Rule #10)

```bash
pnpm build            # also satisfies typecheck — package.json aliases them
pnpm lint
pnpm format:check
pnpm test
```

Then the DB-backed suite, which is the only one that exercises the new SQL:

```bash
POSTGRES_USER=... POSTGRES_PASSWORD=... pnpm migrate
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=... \
  pnpm --filter @hyfib/persistence test
```

`pnpm test` must run **after** `pnpm build` — every backend test imports
`../dist/*.js`, so skipping the build silently tests stale code and a
red-test-first cycle will appear to pass.

---

## 6. Explicitly out of scope

Each of these is real, verified, and deliberately deferred:

1. ~~**Duplicate send-log claims strand recipients.**~~ **RESOLVED on this
   branch.** `handleDispatch` returned without touching the recipient row when
   `tryClaim` found an existing entry, leaving it `pending` forever — latent
   before, but the reclaim sweep in §3.2 would have turned it into a permanent
   re-enqueue source across runs. The suppression is now recorded as
   `policy_skipped` / `skip_reason = 'duplicate_send_suppressed'`.

   Two things made this more than the ~3 lines originally estimated:
   `campaignRecipientRepository.updateStatus` was unconditional (`WHERE id = $1`),
   so a naive write would let an outbox redelivery **downgrade** an already
   `sent`/`delivered`/`read` row. It gained an optional `onlyIfStatus` guard —
   additive, defaulted to the previous unguarded behaviour, with a regression
   test proving a guarded write cannot clobber a `delivered` recipient. The
   write is also best-effort (`.catch` + `dispatch_duplicate_recipient_update_failed`)
   because rethrowing would trigger broker retry and re-suppress forever.

   `policy_skipped` was chosen over `failed` deliberately: nothing went wrong,
   and the funnel's skip bucket is where a deliberate non-send belongs. It also
   reuses an existing status value, so the hardcoded `tenantAnalytics` buckets
   (`packages/persistence/src/repositories.ts:2080-2086`) need no change.
2. Head-of-line blocking (§4).
3. No writer for `'completed'` / `'paused'` — the pause/cancel iteration.
4. The unguarded `UPDATE campaigns SET status='running'` at
   `services/api-gateway/src/index.ts:786`, which lets a test-send silently
   resurrect a paused or cancelled campaign.
5. `campaignRepository.setStatus` (`packages/persistence/src/repositories.ts:784`)
   is unconditional and has **zero callers** — dead code.
6. `services/web-app/src/pages/CampaignsPage.tsx:33` POSTs `/dispatch` with no
   body and is rejected with 400 at `services/api-gateway/src/index.ts:2794` —
   **the campaign start button has never worked.**
7. `GET /api/v1/campaigns` (`:2707`) and `GET /{id}/report` (`:2844`) have no
   role check at all.
8. A quota of `0` is treated as unlimited (`notification-worker/src/index.ts:270`),
   and `monthly_message_quota` has no writer — it is settable only by direct SQL.
9. ~~**`outbox_claim` relies on a planner choice for its `LIMIT` to hold.**~~
   **HARDENED in migration `022`, but the risk was overstated — correcting the
   record.** `015_outbox_durability.sql:27-40` used the same unmaterialised
   `WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT …)` shape that proved
   unsafe for `claimPendingBatch` (§3.2), and this document previously called it
   "not structurally guaranteed".

   **It could not be reproduced.** The bad plan was forced with
   `enable_indexscan`, `enable_bitmapscan`, `enable_indexonlyscan`,
   `enable_hashagg`, `enable_hashjoin`, `enable_material`, `enable_sort`, and
   `enable_mergejoin` all off; the subquery still materialised
   (`Limit … loops=1`, subquery on the *outer* side beneath `Unique`) and
   `outbox_claim(4)` over 12 pending rows returned exactly 4 every time.

   **Why the two cases differ — the mechanism, not luck.** `claimPendingBatch`
   runs as `hyfib_app` against a FORCE-RLS table, so PostgreSQL injects the
   `current_setting('app.tenant_id')` predicate; that pushed the subquery to the
   *inner* side of a `Nested Loop Semi Join`, re-executing it per candidate row.
   `outbox_claim` is `SECURITY DEFINER` running as the table owner, so **no RLS
   predicate is ever injected** and that plan shape was never reached.

   `022` was shipped anyway as **defensive hardening, not a bug fix**: it costs
   one line, changes no behaviour, and removes the dependence on a planner
   choice that a future index or volume change could alter. The accompanying
   test is labelled a characterisation test, not a red-green cycle.

---

## 7. Rule compliance

| Rule | How this design satisfies it |
|------|------------------------------|
| #1 Never rewrite working code | The code being changed is provably not working (§1). One function body and one additive migration. |
| #2 Always audit before coding | 16-agent audit preceded this spec; every claim is anchored to `file:line`. |
| #3 One module per iteration | `packages/persistence` and its own schema. The defaulted parameter in §3.2 is what keeps `notification-worker`'s **executable** code untouched; the only other edit is the comment-only correction in §3.4. |
| #4 Always validate after changes | §5 validation gate, including the DB-backed suite that actually exercises the new SQL. |
| #5 Fix root causes | Fixes the claim itself (§2), not the symptom. Symptom-level fixes (cursor paging) were considered and rejected. |
| #6 Prefer dependency injection | `staleClaimMinutes` is a defaulted parameter, not a module-level constant or a config import inside persistence. |
| #7 Backward compatibility | Additive column; existing rows read as unclaimed; unchanged `RETURNING` shape; unchanged call site. |
| #8 Update tests with code | New integration suite (§5), written test-first, including a case that fails against today's implementation. |
| #10 Definition of done | §5 gate. Note §1.4 — convergence is proven by test 2, not merely by argument. |
