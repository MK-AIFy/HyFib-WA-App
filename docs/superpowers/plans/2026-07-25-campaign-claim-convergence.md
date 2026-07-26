# Campaign Fan-Out Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `campaignRecipientRepository.claimPendingBatch` a real claim so a campaign fan-out run converges instead of re-selecting the same 50 recipients on all 10,000 of its iterations.

**Architecture:** Add a nullable `claimed_at` column to `campaign_recipients` and turn the existing `SELECT` into an `UPDATE … RETURNING` that stamps it, mirroring the `outbox_claim` precedent in `infra/postgres/init/015_outbox_durability.sql:27-40`. A stale-claim reclaim window keeps a crashed run from stranding recipients. The returned column set is unchanged, so no TypeScript type moves and no other module is touched.

**Tech Stack:** PostgreSQL 16, TypeScript (ESM, `tsc -p tsconfig.json`), `node --test` (Node's built-in runner), `pg`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-25-campaign-claim-convergence-design.md`

## Global Constraints

- **Module scope (project Rule #3):** only `packages/persistence` and `infra/postgres/init`. The single exception is the comment-only correction in Task 3 — no executable line in `services/notification-worker` changes.
- **Backward compatibility (Rule #7):** the `RETURNING` list must stay exactly the 13 existing columns so `CampaignRecipientRow`, `mapRecipient`, and the exported `CampaignRecipient` type are untouched. The new parameter must be defaulted so the existing call site at `services/notification-worker/src/index.ts:376` compiles unchanged.
- **No TypeScript union changes.** Adding a `CampaignRecipient["status"]` value would ripple into `packages/shared-core`, the hardcoded analytics buckets at `packages/persistence/src/repositories.ts:2080-2086`, and `services/web-app/src/pages/CampaignsPage.tsx`. This design deliberately avoids that.
- **Migrations are tracked by filename with no checksums** (`scripts/migrate.sh:30`, `:43-48`). Once `021_campaign_recipient_claim.sql` is committed and applied anywhere it can never be edited — only superseded by `022`.
- **Build before test, always.** Every backend test imports `../dist/*.js`. Skipping the build silently tests stale code, and a red-test-first cycle will appear to pass.
- **Backend test files are neither linted nor typechecked** (`eslint.config.mjs:7` ignores `**/*.test.js`; tsconfigs use `include: ["src/**/*.ts"]`). A typo in a helper fails at runtime, not at build.

### Local environment (verified present on this machine)

PostgreSQL is accepting connections on `localhost:5432` and the `hyfib_wa` database exists with the `hyfib_app` role.

```bash
# Apply migrations (superuser path; credentials per scripts/dev-local.sh:78)
POSTGRES_USER="$USER" POSTGRES_PASSWORD=x POSTGRES_DB=hyfib_wa pnpm migrate

# Run the DB-backed suite (app-role path; credentials per scripts/dev-local.sh:51-53)
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Without `RUN_DB_TESTS=1` every test in the new file is skipped and the run is green but vacuous — always confirm the pass count, never just the exit code.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `infra/postgres/init/021_campaign_recipient_claim.sql` | **Create.** Adds `claimed_at` and the partial index supporting the claim predicate. Two statements, both idempotent. |
| `packages/persistence/src/repositories.ts:2454-2469` | **Modify.** Replace the `claimPendingBatch` body; add the defaulted `staleClaimMinutes` parameter. This is the only source change. |
| `packages/persistence/test/campaigns.integration.test.js` | **Create.** DB-backed suite: one `seedCampaign` fixture helper plus the claim's behavioural contract. |
| `services/notification-worker/src/index.ts:365-366`, `:1082-1085` | **Modify (comments only).** Two comments assert advisory locks and idempotent claims that do not exist. |

---

## Task 1: Make the claim a real claim

**Files:**
- Create: `packages/persistence/test/campaigns.integration.test.js`
- Create: `infra/postgres/init/021_campaign_recipient_claim.sql`
- Modify: `packages/persistence/src/repositories.ts:2454-2469`

**Interfaces:**
- Consumes: `tenantRepository.create(name)`, `templateRepository.create(tenantId, {name, category, language, body, status})`, `campaignRepository.create(tenantId, {name, templateId})`, `contactRepository.create(tenantId, {phoneE164})`, `campaignRecipientRepository.insertBatch(tenantId, campaignId, contacts)`, `withTenant`, `closePool` — all exported from `../dist/index.js`.
- Produces: `claimPendingBatch(tenantId, campaignId, batchSize)` now stamps `claimed_at` and never returns an already-claimed row. Task 2 extends the same signature with a fourth parameter.

- [ ] **Step 1: Write the failing test**

Create `packages/persistence/test/campaigns.integration.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  templateRepository,
  campaignRepository,
  contactRepository,
  campaignRecipientRepository,
  withTenant,
  closePool
} from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 021_campaign_recipient_claim.sql. CI provides it via
// service containers; locally run with RUN_DB_TESTS=1 (see rls.integration.test.js).
const skip = !process.env.RUN_DB_TESTS;

/**
 * Creates a tenant with an approved template, a campaign, and `recipientCount`
 * pending recipients. Each test gets its own tenant, so phone numbers only
 * need to be unique within the fixture.
 */
async function seedCampaign(label, recipientCount) {
  const tenant = await tenantRepository.create(`Claim ${label} Tenant`);
  const template = await templateRepository.create(tenant.id, {
    name: `claim_${label.toLowerCase()}_tpl`,
    category: "marketing",
    language: "en_US",
    body: "Hello {{1}}",
    status: "approved"
  });
  const campaign = await campaignRepository.create(tenant.id, {
    name: `Claim ${label} Campaign`,
    templateId: template.id
  });
  const contacts = [];
  for (let i = 0; i < recipientCount; i++) {
    const contact = await contactRepository.create(tenant.id, {
      phoneE164: `+1555${String(i).padStart(7, "0")}`
    });
    contacts.push({ id: contact.id, phoneE164: contact.phoneE164 });
  }
  await campaignRecipientRepository.insertBatch(tenant.id, campaign.id, contacts);
  return { tenant, campaign, contacts };
}

test("claimPendingBatch hands each recipient out exactly once", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Disjoint", 10);

  const first = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);
  const second = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);

  assert.equal(first.length, 4);
  assert.equal(second.length, 4);

  const firstIds = new Set(first.map((r) => r.id));
  const overlap = second.filter((r) => firstIds.has(r.id));
  assert.deepEqual(overlap, [], "a claimed recipient must not be handed out a second time");
});

test("claimPendingBatch converges to an empty batch", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Converge", 10);

  const seen = new Set();
  let batches = 0;
  for (;;) {
    const batch = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);
    if (batch.length === 0) break;
    for (const r of batch) seen.add(r.id);
    batches++;
    assert.ok(batches <= 5, "claim loop did not converge — it is re-returning claimed rows");
  }

  assert.equal(seen.size, 10, "every pending recipient should be claimed exactly once");
  assert.equal(batches, 3, "10 recipients at batchSize 4 should take 3 non-empty batches");
});

test("claimPendingBatch never claims a non-pending recipient", { skip }, async () => {
  const { tenant, campaign, contacts } = await seedCampaign("NonPending", 3);

  await withTenant(tenant.id, async (client) => {
    await client.query(
      `UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[0].id]
    );
    await client.query(
      `UPDATE campaign_recipients SET status = 'policy_skipped' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[1].id]
    );
  });

  const batch = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 10);

  assert.equal(batch.length, 1, "only the single remaining pending row should be claimed");
  assert.equal(batch[0].contactId, contacts[2].id);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **FAIL**. Specifically, `claimPendingBatch hands each recipient out exactly once` fails its `overlap` assertion (the current `SELECT` returns the same first 4 rows both times), and `claimPendingBatch converges to an empty batch` fails on `claim loop did not converge`. The third test passes already — the `status = 'pending'` filter is not what is broken.

This is the executable proof of the bug in the spec's §1.

- [ ] **Step 3: Write the migration**

Create `infra/postgres/init/021_campaign_recipient_claim.sql`:

```sql
-- Campaign fan-out convergence: campaign_recipients needs a claim marker.
--
-- claimPendingBatch was a bare SELECT whose FOR UPDATE SKIP LOCKED locks were
-- released by the enclosing withTenant COMMIT before the caller used a row,
-- and the fan-out loop in notification-worker never marks approved recipients
-- off 'pending' (they leave it only in handleDispatch). Every iteration
-- therefore re-selected the same rows and the loop could not converge.
--
-- claimed_at is stamped by the claim itself, mirroring outbox_claim in
-- 015_outbox_durability.sql. A row whose claim is older than the caller's
-- stale window is reclaimable, so a process that dies between claiming and
-- enqueueing does not strand recipients.
--
-- `status` on campaign_recipients is plain TEXT with no CHECK constraint (see
-- 006_marketing.sql), and this migration adds no status values in any case.

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Serves the claim's `campaign_id = $1 AND status = 'pending'` filter and its
-- `ORDER BY created_at`. The existing idx_campaign_recipients_campaign_status
-- stays; it serves the funnel-count queries.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_claim
  ON campaign_recipients(campaign_id, created_at) WHERE status = 'pending';
```

- [ ] **Step 4: Apply the migration**

```bash
POSTGRES_USER="$USER" POSTGRES_PASSWORD=x POSTGRES_DB=hyfib_wa pnpm migrate
```

Expected: `Applying 021_campaign_recipient_claim.sql...` in the output. Verify the column landed:

```bash
psql -h localhost -d hyfib_wa -c "\d campaign_recipients" | grep claimed_at
```

Expected: a `claimed_at | timestamp with time zone` row.

- [ ] **Step 5: Write the minimal implementation**

In `packages/persistence/src/repositories.ts`, replace the whole `claimPendingBatch` method (currently `:2454-2469`, the one whose doc comment reads "Returns next batch of pending recipients to fan-out (cursor-based pagination)") with:

```ts
  /**
   * Claims the next batch of pending recipients for fan-out.
   *
   * This is a real claim, not a read: it stamps `claimed_at` on the rows it
   * returns, so a later call cannot hand the same recipients out again. The
   * previous implementation was a bare SELECT whose `FOR UPDATE SKIP LOCKED`
   * locks were released by the enclosing `withTenant` COMMIT before the caller
   * touched a row — and because the fan-out loop never marks approved
   * recipients off 'pending' (they leave it only in handleDispatch), every
   * call returned the same batch and the loop could not converge.
   *
   * No SECURITY DEFINER is needed: campaign_recipients is reached through
   * withTenant, so RLS scopes both the CTE and the UPDATE.
   *
   * The `MATERIALIZED` keyword is load-bearing and must not be removed. With
   * the subquery written inline as `WHERE id IN (SELECT ... LIMIT n)` the
   * planner is free to turn it into a semi-join and re-execute the locking
   * subplan once per candidate row; because FOR UPDATE SKIP LOCKED yields
   * different rows on each execution, every outer row then finds a match and
   * the batch size is silently ignored. Measured: a `LIMIT 4` claim over 10
   * pending rows updated all 10 (`Nested Loop Semi Join ... loops=10`).
   * MATERIALIZED forces the CTE to be evaluated exactly once.
   *
   * The RETURNING list is deliberately the pre-existing column set —
   * `claimed_at` is excluded — so CampaignRecipientRow, mapRecipient, and the
   * exported CampaignRecipient type are unchanged.
   */
  async claimPendingBatch(tenantId: string, campaignId: string, batchSize: number): Promise<CampaignRecipient[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<CampaignRecipientRow>(
        `WITH claimed AS MATERIALIZED (
           SELECT c.id FROM campaign_recipients c
           WHERE c.campaign_id = $1
             AND c.status = 'pending'
             AND c.claimed_at IS NULL
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
                   r.sent_at, r.delivered_at, r.read_at, r.created_at`,
        [campaignId, batchSize]
      );
      return result.rows.map(mapRecipient);
    });
  }
```

> **Amended after execution.** This step originally specified the
> `WHERE id IN (SELECT … LIMIT n)` shape copied from `outbox_claim`. The Step 1
> tests caught it failing: `claimPendingBatch converges to an empty batch`
> reported `batches` of 1 instead of 3, because a single `LIMIT 4` claim
> updated all 10 rows. `EXPLAIN (ANALYZE)` showed
> `Nested Loop Semi Join … loops=10` — the locking subplan re-executed per
> candidate row. If you are replaying this plan, expect that intermediate
> failure; `MATERIALIZED` is the fix.

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **PASS** — all three new tests, and every pre-existing persistence test still green. Confirm the summary reports `pass` counts greater than zero; if it reports everything as `skipped`, `RUN_DB_TESTS=1` did not reach the runner.

- [ ] **Step 7: Commit**

```bash
git add infra/postgres/init/021_campaign_recipient_claim.sql \
        packages/persistence/src/repositories.ts \
        packages/persistence/test/campaigns.integration.test.js
git commit -m "fix(campaigns): make claimPendingBatch actually claim

claimPendingBatch was a bare SELECT whose FOR UPDATE SKIP LOCKED locks
were released by the enclosing withTenant COMMIT before the caller used
a row. Combined with a fan-out loop that never marks approved recipients
off 'pending', every iteration re-selected the same 50 people and the
run could not converge.

Adds claimed_at (migration 021) and turns the read into an
UPDATE ... RETURNING that stamps it, mirroring outbox_claim. The
RETURNING list is the pre-existing column set, so no TypeScript type
changes and no other module is touched."
```

---

## Task 2: Reclaim stale claims

**Files:**
- Modify: `packages/persistence/src/repositories.ts` (the `claimPendingBatch` written in Task 1)
- Modify: `packages/persistence/test/campaigns.integration.test.js`

**Interfaces:**
- Consumes: `claimPendingBatch(tenantId, campaignId, batchSize)` from Task 1.
- Produces: `claimPendingBatch(tenantId, campaignId, batchSize, staleClaimMinutes = 15)`. The fourth parameter is defaulted so `services/notification-worker/src/index.ts:376` keeps compiling untouched.

- [ ] **Step 1: Write the failing test**

Append these two tests to `packages/persistence/test/campaigns.integration.test.js`, immediately **before** the existing `test.after(...)` block:

```js
test("claimPendingBatch reclaims a stale claim but leaves a fresh one alone", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Stale", 2);

  const claimed = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.equal(claimed.length, 2);

  // Nothing is stale yet, so a second claim finds nothing.
  const immediate = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.deepEqual(immediate, [], "a claim inside the stale window must not be reclaimed");

  // Backdate exactly one row's claim past the window.
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaign_recipients SET claimed_at = now() - INTERVAL '30 minutes' WHERE id = $1`, [
      claimed[0].id
    ]);
  });

  const reclaimed = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.equal(reclaimed.length, 1, "only the backdated row should be reclaimed");
  assert.equal(reclaimed[0].id, claimed[0].id);
});

test("claimPendingBatch is tenant-isolated through the new UPDATE", { skip }, async () => {
  const owner = await seedCampaign("OwnerIso", 3);
  const other = await seedCampaign("OtherIso", 3);

  // Claiming as the other tenant must not reach the owner's campaign: the RLS
  // policy on campaign_recipients scopes the UPDATE, not just the subquery.
  const crossTenant = await campaignRecipientRepository.claimPendingBatch(other.tenant.id, owner.campaign.id, 10);
  assert.deepEqual(crossTenant, [], "a tenant must not claim another tenant's recipients");

  // The owner's rows are therefore still unclaimed and fully available.
  const ownClaim = await campaignRecipientRepository.claimPendingBatch(owner.tenant.id, owner.campaign.id, 10);
  assert.equal(ownClaim.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **FAIL** on `claimPendingBatch reclaims a stale claim but leaves a fresh one alone` — the final assertion gets `reclaimed.length === 0` because Task 1's predicate is `claimed_at IS NULL` with no stale window, so a backdated row is still excluded. The extra fourth argument is silently ignored by JavaScript until Step 3.

`claimPendingBatch is tenant-isolated through the new UPDATE` should already **pass**; it is a regression guard against a future refactor bypassing `withTenant`, not a new behaviour.

- [ ] **Step 3: Add the stale window to the implementation**

In `packages/persistence/src/repositories.ts`, change the `claimPendingBatch` signature and its `WHERE` clause. Replace:

```ts
  async claimPendingBatch(tenantId: string, campaignId: string, batchSize: number): Promise<CampaignRecipient[]> {
```

with:

```ts
  async claimPendingBatch(
    tenantId: string,
    campaignId: string,
    batchSize: number,
    staleClaimMinutes = 15
  ): Promise<CampaignRecipient[]> {
```

Replace this line:

```ts
             AND c.claimed_at IS NULL
```

with:

```ts
             AND (c.claimed_at IS NULL OR c.claimed_at < now() - make_interval(mins => $3::int))
```

Replace the parameter array:

```ts
        [campaignId, batchSize]
```

with:

```ts
        [campaignId, batchSize, staleClaimMinutes]
```

And extend the doc comment by appending this paragraph before the closing `*/`:

```
   * A claimed row becomes reclaimable after `staleClaimMinutes` so a process
   * that dies between claiming and enqueueing does not strand recipients. The
   * window must exceed one batch's wall time — batchSize / ratePerMinute,
   * because pacing happens inside the fan-out loop — so the 2-minute constant
   * outbox_claim uses would be wrong here. Reclaiming too early costs a
   * duplicate outbox row, never a duplicate send: campaignSendLog.tryClaim is
   * the exactly-once guard at send time.
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **PASS** — all five new tests plus the pre-existing suites.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/repositories.ts packages/persistence/test/campaigns.integration.test.js
git commit -m "fix(campaigns): reclaim stale recipient claims after a timeout

A process that dies between claiming a batch and enqueueing it would
otherwise strand those recipients as permanently claimed. staleClaimMinutes
defaults to 15 and is a parameter rather than a constant so the window can
be tuned to ratePerMinute; the worker call site is unchanged.

Reclaiming too early costs a duplicate outbox row, never a duplicate send —
campaignSendLog.tryClaim remains the exactly-once guard."
```

---

## Task 3: Correct the false comments and run the full gate

**Files:**
- Modify: `services/notification-worker/src/index.ts:365-366`, `:1082-1085` (comments only)

**Interfaces:**
- Consumes: nothing. No executable code changes in this task.
- Produces: nothing.

- [ ] **Step 1: Read the two comments in place**

```bash
sed -n '363,368p;1080,1087p' services/notification-worker/src/index.ts
```

The first asserts that `claimPendingBatch` "advisory-locks rows so a restarted worker won't re-dispatch the same contacts" — `pg_advisory_lock` appears nowhere in the repository. The second asserts "the synchronous in-memory bus + idempotent claimPendingBatch make re-processing safe" — false on both halves. Confirm both are still present and that the surrounding line numbers match before editing; they may have shifted.

- [ ] **Step 2: Rewrite the claim comment**

Replace the sentence claiming advisory locks with an accurate one:

```ts
  // claimPendingBatch stamps claimed_at on the rows it returns, so a restarted
  // worker (or a second concurrent loop) never re-dispatches the same contacts.
  // Claims older than the repository's stale window are reclaimable, so a crash
  // between claiming and enqueueing does not strand recipients.
```

- [ ] **Step 3: Rewrite the re-processing comment**

Replace the "synchronous in-memory bus + idempotent claimPendingBatch make re-processing safe" sentence with:

```ts
  // Re-processing safety comes from two places: claimPendingBatch will not hand
  // out an already-claimed recipient, and campaignSendLog.tryClaim is the
  // exactly-once guard at send time. Note the in-memory bus awaits handler
  // completion, so a long fan-out blocks the outbox relay for its duration.
```

- [ ] **Step 4: Run the full validation gate**

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm test
```

Expected: build clean, lint reporting no **errors** (pre-existing warnings in `notification-worker` are acceptable and predate this work), format check clean, all suites passing. If `format:check` fails on a file this plan touched, run `pnpm format` and re-run the gate.

Then re-run the DB-backed suite, since `pnpm test` does not set `RUN_DB_TESTS`:

```bash
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

- [ ] **Step 5: Commit**

```bash
git add services/notification-worker/src/index.ts
git commit -m "docs(worker): correct false claims about advisory locks and idempotency

Two comments asserted safety invariants that do not exist: claimPendingBatch
never took advisory locks (pg_advisory_lock appears nowhere in the repo), and
it was not idempotent until migration 021. Comment-only change.

Also records that the in-memory bus awaits handler completion, so a long
fan-out blocks the outbox relay — the head-of-line issue is real and
deliberately not fixed here."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|--------------|------|
| §3.1 Schema — migration 021 | Task 1 Steps 3-4 |
| §3.2 The claim — `UPDATE … RETURNING`, unchanged column set, no `SECURITY DEFINER` | Task 1 Step 5 |
| §3.2 Defaulted `staleClaimMinutes` parameter | Task 2 Step 3 |
| §3.3 15-minute default and its rationale | Task 2 Step 3 (doc comment) |
| §3.4 Stale comment corrections | Task 3 Steps 2-3 |
| §5 Test case 1 — claim excludes claimed rows | Task 1 Step 1, test 1 |
| §5 Test case 2 — convergence | Task 1 Step 1, test 2 |
| §5 Test case 3 — concurrency | **Deliberately omitted** — see below |
| §5 Test case 4 — stale reclaim | Task 2 Step 1, test 1 |
| §5 Test case 5 — tenant isolation | Task 2 Step 1, test 2 |
| §5 Test case 6 — non-pending rows never claimed | Task 1 Step 1, test 3 |
| §5 Validation gate | Task 3 Step 4 |

**Deliberate omission — spec §5 test case 3 (two concurrent claimers get disjoint sets).** Writing this against a shared pool is racy: `withTenant` takes a connection per call, and two overlapping `claimPendingBatch` promises would interleave non-deterministically against a default `DB_POOL_MAX` of 10, producing a test that passes or fails by timing. `FOR UPDATE SKIP LOCKED` is standard PostgreSQL semantics carried over verbatim from `outbox_claim`, and disjointness under *sequential* calls — the property that was actually broken — is covered by Task 1 test 1. A flaky test is worse than an absent one. Recorded here rather than silently dropped.

**Placeholder scan:** No `TBD` / `TODO` / "add appropriate error handling" / "similar to Task N". Every code step contains complete, runnable content.

**Type consistency:** `claimPendingBatch` is spelled identically in Tasks 1, 2, and 3. Task 1 defines the three-parameter form; Task 2 extends it to four with a default and Task 2's tests pass the fourth argument explicitly. `seedCampaign` returns `{ tenant, campaign, contacts }` and every call site destructures only those three keys. `CampaignRecipient` fields used in assertions (`id`, `contactId`) match `mapRecipient` at `packages/persistence/src/repositories.ts:2303-2319`.

**One risk worth naming:** `insertBatch` writes all recipients inside a single `withTenant` transaction, and PostgreSQL's `now()` is transaction-start time — so every fixture row shares an identical `created_at`. `ORDER BY created_at` is therefore a tie across the whole batch and row order is unspecified. This does not affect correctness (disjointness comes from `claimed_at`, not from ordering) and no test asserts a particular order, but do not add one that does.
