# Campaign Pause / Resume (A2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /api/v1/campaigns/{id}/pause` and `/resume`, and stop the test-send path from silently un-pausing a campaign.

**Architecture:** Three layers, because `services/api-gateway` has no route-level tests — all 155 of its tests are pure-function unit tests against extracted modules. Transition policy goes in the pure `src/campaign.ts`; the guarded compare-and-swap goes in `packages/persistence`; the routes are thin glue that sequences them.

**Tech Stack:** TypeScript (ESM, `tsc -p tsconfig.json`), Node's built-in `node --test`, `pg`, PostgreSQL 16 with FORCE RLS.

**Spec:** `docs/superpowers/specs/2026-07-26-campaign-pause-resume-design.md`

## Global Constraints

- **No new campaign status values.** `paused` already exists in the TS union (`packages/shared-core/src/index.ts:137`) and `campaigns.status` is plain `TEXT` with no CHECK constraint. **No migration is required by this plan.** `cancelled` arrives in A2c.
- **Never assume an UPDATE applied.** Under FORCE RLS an `UPDATE campaigns` outside `withTenant` matches zero rows and raises no error. Every status write checks `RETURNING`/`rowCount`.
- **Leave `campaignRepository.setStatus` alone** (`packages/persistence/src/repositories.ts:784`) — unconditional, `void`, zero callers. Project rule 1. Do not extend it; an unguarded status write is what this work exists to avoid.
- **Build before test, always.** Every backend test imports `../dist/*.js`. Skipping the build silently tests stale code.
- **`pnpm test` does not set `RUN_DB_TESTS`,** so persistence integration tests report as skipped and the run is green vacuously. Always finish with the DB-backed command and check the pass count.

### Local environment (verified)

```bash
# DB-backed suite
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

---

## File Structure

| File | Responsibility |
|------|----------------|
| `services/api-gateway/src/campaign.ts` | **Modify.** Add the transition table and its two pure helpers alongside the existing `filterSendableContacts`. |
| `services/api-gateway/test/campaign.test.js` | **Modify.** Extend with transition-policy cases. |
| `packages/persistence/src/repositories.ts` | **Modify.** Add `campaignRepository.transition`. |
| `packages/persistence/test/campaigns.integration.test.js` | **Modify.** Extend with CAS cases. |
| `services/api-gateway/test/rate-limit.test.js` | **Modify.** Pin `/pause` and `/resume` to the `write` bucket. |
| `services/api-gateway/src/index.ts` | **Modify.** Two route branches; guard the unguarded UPDATE at `:786`. |

---

## Task 1: Transition policy (pure, api-gateway)

**Files:**
- Modify: `services/api-gateway/src/campaign.ts`
- Test: `services/api-gateway/test/campaign.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CampaignAction` (`"pause" | "resume"`), `CAMPAIGN_TRANSITIONS`, `canTransition(current: string, action: CampaignAction): boolean`, `transitionConflict(current: string, action: CampaignAction): string`. Task 3 imports all four.

- [ ] **Step 1: Write the failing test**

Append to `services/api-gateway/test/campaign.test.js`:

```js
import { CAMPAIGN_TRANSITIONS, canTransition, transitionConflict } from "../dist/campaign.js";

test("canTransition: pause is legal from running and scheduled only", () => {
  assert.equal(canTransition("running", "pause"), true);
  assert.equal(canTransition("scheduled", "pause"), true);
  for (const status of ["draft", "paused", "completed"]) {
    assert.equal(canTransition(status, "pause"), false, `pause from ${status} must be illegal`);
  }
});

test("canTransition: resume is legal from paused only", () => {
  assert.equal(canTransition("paused", "resume"), true);
  for (const status of ["draft", "scheduled", "running", "completed"]) {
    assert.equal(canTransition(status, "resume"), false, `resume from ${status} must be illegal`);
  }
});

test("canTransition: an unknown status is never transitionable", () => {
  assert.equal(canTransition("banana", "pause"), false);
  assert.equal(canTransition("banana", "resume"), false);
});

test("CAMPAIGN_TRANSITIONS declares the target status for each action", () => {
  assert.equal(CAMPAIGN_TRANSITIONS.pause.to, "paused");
  assert.equal(CAMPAIGN_TRANSITIONS.resume.to, "running");
});

test("transitionConflict names the current status so the operator can act on it", () => {
  assert.match(transitionConflict("completed", "pause"), /completed/);
  assert.match(transitionConflict("running", "resume"), /running/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @hyfib/api-gateway build
pnpm --filter @hyfib/api-gateway test
```

Expected: **FAIL** — the build itself errors, because `../dist/campaign.js` exports none of these names yet. That is a legitimate red; fix it by implementing, not by softening the test.

- [ ] **Step 3: Write the implementation**

Append to `services/api-gateway/src/campaign.ts`:

```ts
export type CampaignAction = "pause" | "resume";

/**
 * The campaign status transitions this service will perform, and the only
 * statuses each is legal from. Declared once here rather than as magic literals
 * in the router: the same set is needed by the route's read-side pre-check (for
 * a good 409 message) and by the guarded UPDATE (for race safety), and the two
 * drifting apart is exactly how a status machine rots.
 *
 * Pausing a 'scheduled' campaign de-schedules it for free — due_scheduled_campaigns
 * filters status='scheduled' — and scheduled_at survives, since only the scheduler's
 * own claim NULLs it. Resume therefore returns to 'running', not 'scheduled': a
 * resumed campaign runs now rather than waiting on a time that has likely passed.
 *
 * Pure (no I/O) so it is unit-testable, like filterSendableContacts above.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignAction, { from: readonly string[]; to: string }> = {
  pause: { from: ["running", "scheduled"], to: "paused" },
  resume: { from: ["paused"], to: "running" }
};

/** True when `action` may be applied to a campaign currently in `current`. */
export function canTransition(current: string, action: CampaignAction): boolean {
  return CAMPAIGN_TRANSITIONS[action].from.includes(current);
}

/** Operator-facing 409 message, phrased like the existing guard in runCampaign. */
export function transitionConflict(current: string, action: CampaignAction): string {
  const legal = CAMPAIGN_TRANSITIONS[action].from.join(" or ");
  return `Cannot ${action} a campaign that is ${current}; it must be ${legal}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @hyfib/api-gateway build
pnpm --filter @hyfib/api-gateway test
```

Expected: **PASS**, with the api-gateway suite rising from 155 to 160.

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/campaign.ts services/api-gateway/test/campaign.test.js
git commit -m "feat(campaigns): pure transition policy for pause/resume"
```

---

## Task 2: Guarded CAS (persistence)

**Files:**
- Modify: `packages/persistence/src/repositories.ts`
- Test: `packages/persistence/test/campaigns.integration.test.js`

**Interfaces:**
- Consumes: `withTenant`, `QueryClient` (both from `./db.js`, re-exported by the package index).
- Produces: `campaignRepository.transition(tenantId: string, id: string, from: readonly string[], to: string, client?: QueryClient): Promise<boolean>`. Task 3 calls it both with and without a client.

- [ ] **Step 1: Write the failing test**

Append to `packages/persistence/test/campaigns.integration.test.js`, before the `test.after(...)` block. `seedCampaign` already exists in that file and returns `{ tenant, campaign, contacts }`; campaigns are created in `draft`.

```js
async function readCampaignStatus(tenantId, campaignId) {
  return withTenant(tenantId, async (client) => {
    const r = await client.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    return r.rows[0]?.status;
  });
}

test("transition applies from a legal status and reports that it applied", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionOk", 1);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [campaign.id]);
  });

  const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running", "scheduled"], "paused");

  assert.equal(applied, true);
  assert.equal(await readCampaignStatus(tenant.id, campaign.id), "paused");
});

test("transition is a no-op from an illegal status and returns false", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionIllegal", 1);
  // Campaign is 'draft', which is not a legal source for pause.

  const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running", "scheduled"], "paused");

  assert.equal(applied, false, "an illegal transition must report false, not throw");
  assert.equal(await readCampaignStatus(tenant.id, campaign.id), "draft", "status must be untouched");
});

test("transition cannot cross tenants", { skip }, async () => {
  const owner = await seedCampaign("TransitionOwner", 1);
  const other = await seedCampaign("TransitionOther", 1);
  await withTenant(owner.tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [owner.campaign.id]);
  });

  const applied = await campaignRepository.transition(
    other.tenant.id,
    owner.campaign.id,
    ["running"],
    "paused"
  );

  assert.equal(applied, false, "another tenant must not be able to transition this campaign");
  assert.equal(await readCampaignStatus(owner.tenant.id, owner.campaign.id), "running");
});

test("transition joins a caller's transaction and rolls back with it", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionTxn", 1);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [campaign.id]);
  });

  // Resume must flip status and enqueue its run event atomically. Prove the flip
  // is genuinely inside the caller's transaction by aborting that transaction.
  await assert.rejects(
    withTenant(tenant.id, async (client) => {
      const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running"], "paused", client);
      assert.equal(applied, true);
      throw new Error("abort");
    }),
    /abort/
  );

  assert.equal(
    await readCampaignStatus(tenant.id, campaign.id),
    "running",
    "a rolled-back transaction must leave the status unchanged"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **FAIL** — `campaignRepository.transition is not a function`.

- [ ] **Step 3: Write the implementation**

In `packages/persistence/src/repositories.ts`, add to `campaignRepository` immediately after `getById`. Leave `setStatus` untouched.

```ts
  /**
   * Compare-and-swap a campaign's status: applies only if it is currently one of
   * `from`. Returns whether a row actually changed.
   *
   * CAS rather than read-then-write because two concurrent operators, or a pause
   * racing the scheduler's 'scheduled' -> 'running' claim, would both pass a
   * read-side guard. Same reasoning as the comment in runCampaign.
   *
   * The caller MUST use the return value. Under FORCE RLS an UPDATE issued
   * without a tenant context matches zero rows and raises no error, so a silent
   * no-op is the most likely production failure mode for a status write.
   *
   * Pass `client` to run inside a transaction the caller already opened — resume
   * needs the status flip and its outbox enqueue to commit together, or a crash
   * between them strands a 'running' campaign no worker was told about. Mirrors
   * outboxRepository.enqueue, the existing client-accepting precedent.
   */
  async transition(
    tenantId: string,
    id: string,
    from: readonly string[],
    to: string,
    client?: QueryClient
  ): Promise<boolean> {
    const run = async (c: QueryClient): Promise<boolean> => {
      const result = await c.query<{ id: string }>(
        `UPDATE campaigns SET status = $3 WHERE id = $1 AND status = ANY($2) RETURNING id`,
        [id, [...from], to]
      );
      return result.rows.length > 0;
    };
    return client ? run(client) : withTenant(tenantId, run);
  },
```

If `QueryClient` is not already imported in `repositories.ts`, add it to the existing import from `./db.js`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @hyfib/persistence build
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: **PASS**, 42 → 46, with `skipped 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/repositories.ts packages/persistence/test/campaigns.integration.test.js
git commit -m "feat(campaigns): guarded status CAS in campaignRepository"
```

---

## Task 3: Routes and the root-cause guard (api-gateway)

**Files:**
- Modify: `services/api-gateway/src/index.ts`
- Test: `services/api-gateway/test/rate-limit.test.js`

**Interfaces:**
- Consumes: `canTransition`, `transitionConflict`, `CAMPAIGN_TRANSITIONS` (Task 1); `campaignRepository.transition` (Task 2).
- Produces: two HTTP routes. Nothing downstream imports from this task.

- [ ] **Step 1: Write the failing rate-limit test**

The routes themselves have no test home, but their throttling class does, and getting it wrong would throttle an operator trying to stop a bad send. Append to `services/api-gateway/test/rate-limit.test.js`:

```js
test("classifyRoute: campaign pause/resume are ordinary writes, never expensive", () => {
  // 'expensive' is 10/min. An operator hammering stop during a bad send must not
  // be throttled out of stopping, so these must land in the 120/min write bucket.
  assert.equal(classifyRoute("POST", `/api/v1/campaigns/${CAMPAIGN_ID}/pause`), "write");
  assert.equal(classifyRoute("POST", `/api/v1/campaigns/${CAMPAIGN_ID}/resume`), "write");
});
```

- [ ] **Step 2: Run it and confirm it already passes**

```bash
pnpm --filter @hyfib/api-gateway build
pnpm --filter @hyfib/api-gateway test
```

Expected: **PASS immediately.** `CAMPAIGN_RUN_PATTERN` is anchored `^/api/v1/campaigns/{uuid}/run$`, so `/pause` and `/resume` fall through `MUTATING_METHODS` to `write`. This is a characterisation test pinning behaviour that is already correct — it is not a red-green cycle, and it exists so a future broadening of that pattern to `/campaigns/{id}/*` fails loudly here.

- [ ] **Step 3: Add the two routes**

In `services/api-gateway/src/index.ts`, add the import to the existing `./campaign.js` import line:

```ts
import { filterSendableContacts, canTransition, transitionConflict, CAMPAIGN_TRANSITIONS } from "./campaign.js";
```

Insert both branches after the `/run` branch closes and before the `// Campaign delivery funnel report.` comment:

```ts
  // Campaign pause / resume. Pause stops future starts and de-schedules; it does
  // not abort a fan-out already in flight (that arrives with the worker abort
  // check). Resume re-enqueues the run without touching campaign_recipients, so
  // the audience stays exactly as it was at start — unlike /run, which
  // re-resolves the segment.
  if (path.startsWith("/api/v1/campaigns/") && (path.endsWith("/pause") || path.endsWith("/resume")) && method === "POST") {
    const action = path.endsWith("/pause") ? "pause" : "resume";
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: `Insufficient role to ${action} campaigns` });
      return;
    }
    const campaignId = extractPathSegment(path, "/api/v1/campaigns/");
    if (!campaignId || !UUID.test(campaignId)) {
      sendJson(res, 400, { error: "Invalid campaign id" });
      return;
    }
    const campaign = await campaignRepository.getById(tenantId, campaignId);
    if (!campaign) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }
    // Read-side pre-check: produces a message naming the actual status. The CAS
    // below is what actually closes the race.
    if (!canTransition(campaign.status, action)) {
      sendJson(res, 409, { error: transitionConflict(campaign.status, action) });
      return;
    }
    const { from, to } = CAMPAIGN_TRANSITIONS[action];

    if (action === "pause") {
      const applied = await campaignRepository.transition(tenantId, campaignId, from, to);
      if (!applied) {
        sendJson(res, 409, { error: "Campaign status changed concurrently" });
        return;
      }
      // Pending count lets the operator tell a real stop from a no-op: pausing a
      // campaign that drained weeks ago returns 0.
      const counts = await campaignRecipientRepository.funnelCounts(tenantId, campaignId);
      await audit(tenantId, auth, {
        action: "campaign.paused",
        resourceType: "Campaign",
        resourceId: campaignId,
        payload: { pendingRecipients: counts.pending ?? 0 }
      });
      sendJson(res, 200, { status: "paused", campaignId, pendingRecipients: counts.pending ?? 0 });
      return;
    }

    // Resume needs everything runCampaign puts on the event, since the worker
    // treats the payload as a frozen snapshot of the run's parameters.
    const template = await templateRepository.getById(tenantId, campaign.templateId);
    if (!template) {
      sendJson(res, 409, { error: "Template not found" });
      return;
    }
    const channel = await channelRepository.firstActive(tenantId);
    if (!channel) {
      sendJson(res, 409, { error: "No active WhatsApp channel configured for tenant" });
      return;
    }
    let resumed = false;
    await withTenant(tenantId, async (client) => {
      // Status flip and event enqueue must commit together, or a crash between
      // them leaves a 'running' campaign no worker was ever told about.
      resumed = await campaignRepository.transition(tenantId, campaignId, from, to, client);
      if (resumed) {
        await outboxRepository.enqueue(client, tenantId, {
          topic: EventTopics.CampaignRunRequested,
          payload: {
            campaignId,
            tenantId,
            channelId: channel.id,
            templateName: campaign.templateName,
            templateLanguage: campaign.templateLanguage,
            templateCategory: campaign.templateCategory,
            templateStatus: campaign.templateStatus ?? "approved",
            variableMapping: campaign.variableMapping,
            quietHours: campaign.quietHours,
            frequencyCap: campaign.frequencyCap,
            ratePerMinute: campaign.ratePerMinute
          }
        });
      }
    });
    if (!resumed) {
      sendJson(res, 409, { error: "Campaign status changed concurrently" });
      return;
    }
    await audit(tenantId, auth, {
      action: "campaign.resumed",
      resourceType: "Campaign",
      resourceId: campaignId,
      payload: {}
    });
    sendJson(res, 202, { status: "resumed", campaignId });
    return;
  }
```

- [ ] **Step 4: Guard the unguarded status write**

In `dispatchCampaign`, replace:

```ts
      await client.query("UPDATE campaigns SET status = 'running' WHERE id = $1", [campaign.id]);
```

with:

```ts
      // Guarded so a single-number test send cannot silently resurrect a paused
      // campaign to 'running'. Without this, pause is not durable: one test send
      // undoes it with no signal to the operator. The send itself still happens —
      // only the unintended status side-effect is removed.
      await client.query(
        "UPDATE campaigns SET status = 'running' WHERE id = $1 AND status IN ('draft', 'scheduled', 'running')",
        [campaign.id]
      );
```

- [ ] **Step 5: Run the full validation gate**

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm test
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Expected: build clean; lint 0 errors (4 pre-existing `no-explicit-any` warnings in notification-worker are acceptable); format clean; 0 test failures; persistence 46 pass / 0 skipped. If `format:check` flags a touched file, run `pnpm format` and re-run.

- [ ] **Step 6: Commit**

```bash
git add services/api-gateway/src/index.ts services/api-gateway/test/rate-limit.test.js
git commit -m "feat(campaigns): pause and resume endpoints"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 Layer 1 transition policy | Task 1 |
| §3 Layer 2 guarded CAS, optional client | Task 2 |
| §3 Layer 3 routes, status codes, `pendingRecipients` | Task 3 Step 3 |
| §3 Resume event payload mirrors runCampaign | Task 3 Step 3 |
| §3 Resume does not touch campaign_recipients | Task 3 Step 3 (no `insertBatch` call) |
| §3 Rate limiting stays `write` | Task 3 Steps 1-2 |
| §4 Root-cause guard at `:786` | Task 3 Step 4 |
| §5 Test placement, all three layers | Tasks 1, 2, 3 |
| §6 Validation | Task 3 Step 5 |

**Placeholder scan:** none — no TBD, no "add error handling", every code step is complete and runnable.

**Type consistency:** `CampaignAction` is `"pause" | "resume"` in Task 1 and the router derives `action` from the path as one of exactly those two strings. `CAMPAIGN_TRANSITIONS[action]` destructures to `{ from, to }`, matching the declared `Record<CampaignAction, { from: readonly string[]; to: string }>`. `transition`'s `from: readonly string[]` accepts `CAMPAIGN_TRANSITIONS[action].from` directly. `funnelCounts` returns `Record<string, number>`, so `counts.pending` is `number | undefined` and is defaulted with `?? 0` at both use sites.

**Two risks worth naming.**

`campaign.status` is typed `Campaign["status"]`, a union that does not include arbitrary strings, while `canTransition` takes `string`. That widening is intentional — `repositories.ts:696` casts the DB value with an unchecked `as`, so an out-of-union string can reach here, and `canTransition` returning `false` for `"banana"` is the desired behaviour rather than a type error. Task 1's third test pins it.

Task 3 Step 2 is a characterisation test, not a red-green cycle, and is labelled as such in the step. The routes themselves remain untested, which is consistent with every other route in this service but does mean the glue in Step 3 is verified only by the full-stack gate and by review.
