# Pause Stops Queued Sends (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paused or cancelled campaign stops sending the dispatches already sitting in the outbox.

**Architecture:** One status guard in `handleDispatch`, placed before the send-log claim so a skipped recipient stays fully re-sendable. No new repository method — `campaignRepository.getStatus` already exists.

**Tech Stack:** TypeScript (ESM, `tsc -p tsconfig.json`), Node's built-in `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-26-pause-stops-queued-sends-design.md`

## Global Constraints

- **Single module.** Only `services/notification-worker/src/index.ts` changes.
- **Order is load-bearing.** The check must precede `campaignSendLog.tryClaim`. Claiming and then skipping would burn the exactly-once claim on a message that never sent, and `tryClaim` would refuse that recipient forever — resume would silently skip them.
- **Do not touch the recipient row on the skip path.** It must stay `pending` so the stale-claim reclaim (migration `021`) makes it re-dispatchable after resume. This is the opposite of the duplicate-suppression path, which must retire the row.
- **Only `running` proceeds.** Any other value, including `undefined`, skips. An unrecognised status should stop sends, not permit them.
- **Test sends (no `recipientId`) are exempt** and must not even incur the status read.
- **Build before test** — tests import `../dist/*.js`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `services/notification-worker/src/index.ts` | **Modify.** Add the guard at the top of `handleDispatch`. |
| `services/notification-worker/test/dispatch-campaign-stopped.test.js` | **Create.** The guard's behavioural contract. |

---

## Task 1: Gate fan-out dispatches on campaign status

**Files:**
- Create: `services/notification-worker/test/dispatch-campaign-stopped.test.js`
- Modify: `services/notification-worker/src/index.ts` (`handleDispatch`, currently at `:250`)

**Interfaces:**
- Consumes: `campaignRepository.getStatus(tenantId, id): Promise<string | undefined>` (added in A2b), `campaignSendLog.tryClaim`, `campaignRecipientRepository.updateStatus`.
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Create `services/notification-worker/test/dispatch-campaign-stopped.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import { campaignRepository, campaignSendLog, campaignRecipientRepository } from "@hyfib/persistence";
import { EventTopics } from "@hyfib/shared-core";

/**
 * Pause and cancel must stop the dispatches already sitting in the outbox, not
 * just stop the fan-out claiming new batches.
 *
 * The guard runs before campaignSendLog.tryClaim on purpose: claiming and then
 * skipping would burn the exactly-once claim on a message that never sent, and
 * tryClaim would refuse that recipient forever, so resume would silently skip
 * them. These tests assert tryClaim is never reached.
 *
 * Same fake-bus + monkey-patch technique as replay.test.js; no Postgres touched.
 */

function createFakeBus() {
  const handlers = new Map();
  return {
    handlers,
    subscribe(topic, _queue, handler) {
      handlers.set(topic, handler);
    },
    async publish() {},
    async close() {}
  };
}

function dispatchEvent(overrides = {}) {
  return {
    id: "env-stop-1",
    topic: EventTopics.CampaignDispatchRequested,
    occurredAt: new Date().toISOString(),
    payload: {
      tenantId: "t-1",
      campaignId: "camp-1",
      channelId: "c-1",
      templateName: "promo",
      templateLanguage: "en_US",
      templateCategory: "marketing",
      contactPhoneE164: "+15551230000",
      parameters: [],
      recipientId: "rec-1",
      ...overrides
    }
  };
}

/** Installs stubs, runs the consumer, restores, and reports what was touched. */
async function driveDispatch({ status, payload = {} }) {
  const bus = createFakeBus();
  const originalGetStatus = campaignRepository.getStatus;
  const originalTryClaim = campaignSendLog.tryClaim;
  const originalUpdateStatus = campaignRecipientRepository.updateStatus;

  const statusReads = [];
  let claims = 0;
  const updates = [];

  campaignRepository.getStatus = async (tenantId, id) => {
    statusReads.push({ tenantId, id });
    return status;
  };
  campaignSendLog.tryClaim = async () => {
    claims++;
    return false; // Stop the handler here; the send path itself is not under test.
  };
  campaignRecipientRepository.updateStatus = async (...args) => {
    updates.push(args);
  };

  try {
    registerWorkerConsumers({ eventBus: bus });
    const handleDispatch = bus.handlers.get(EventTopics.CampaignDispatchRequested);
    await handleDispatch(dispatchEvent(payload));
  } finally {
    campaignRepository.getStatus = originalGetStatus;
    campaignSendLog.tryClaim = originalTryClaim;
    campaignRecipientRepository.updateStatus = originalUpdateStatus;
  }
  return { statusReads, claims, updates };
}

for (const stopped of ["paused", "cancelled", "completed", undefined]) {
  test(`handleDispatch: a queued send for a ${stopped ?? "missing"} campaign is skipped`, async () => {
    const { claims, updates } = await driveDispatch({ status: stopped });

    assert.equal(claims, 0, "the send-log claim must not be consumed for a message that will not be sent");
    assert.deepEqual(updates, [], "the recipient row must stay pending so resume can re-dispatch it");
  });
}

test("handleDispatch: a running campaign still dispatches", async () => {
  const { statusReads, claims } = await driveDispatch({ status: "running" });

  assert.deepEqual(statusReads, [{ tenantId: "t-1", id: "camp-1" }]);
  assert.equal(claims, 1, "a running campaign must proceed to the send-log claim as before");
});

test("handleDispatch: a test send carries no recipientId and is never gated", async () => {
  // POST /campaigns/{id}/dispatch is an explicit one-off operator action, not
  // queued fan-out work. It must not pay for the status read either.
  const { statusReads, claims } = await driveDispatch({
    status: "paused",
    payload: { recipientId: undefined }
  });

  assert.deepEqual(statusReads, [], "a test send must not read campaign status");
  assert.equal(claims, 1, "a test send proceeds even when the campaign is paused");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @hyfib/notification-worker build
pnpm --filter @hyfib/notification-worker test
```

Expected: **FAIL** on the four `is skipped` cases — `claims` is 1 because `handleDispatch` reaches `tryClaim` unconditionally today. The `running` and test-send cases should already pass; they are guards against over-correcting.

- [ ] **Step 3: Write the implementation**

In `services/notification-worker/src/index.ts`, inside `handleDispatch`, insert immediately after the `dispatch_invalid_command` validation block and immediately before the `// Dedupe: claim before sending` comment:

```ts
  // Stop queued fan-out sends for a campaign that is no longer running. A2b
  // stopped the loop claiming new batches, but everything already written to
  // the outbox would otherwise still send, so pause looked ineffective for as
  // long as the backlog took to drain.
  //
  // This runs BEFORE tryClaim deliberately. campaign_send_log rows are never
  // deleted on success, so claiming and then skipping would burn the
  // exactly-once claim on a message that never sent and tryClaim would refuse
  // that recipient forever — resume would silently skip them.
  //
  // Only fan-out sends are gated. A dispatch with no recipientId is the
  // single-number test send, an explicit operator action rather than queued
  // work, and it must not even pay for the status read.
  //
  // Not cached on purpose: any TTL is added pause latency, and getStatus is a
  // primary-key lookup, negligible beside the monthly COUNT(*) below.
  if (command.recipientId) {
    const campaignStatus = await campaignRepository.getStatus(command.tenantId, command.campaignId);
    if (campaignStatus !== "running") {
      // The recipient row is deliberately left 'pending' with its claimed_at
      // intact: the stale-claim reclaim makes it re-dispatchable once the
      // campaign resumes. Marking it here would make pause lossy.
      logger.info("dispatch_skipped_campaign_not_running", {
        campaignId: command.campaignId,
        status: campaignStatus ?? "missing"
      });
      return;
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @hyfib/notification-worker build
pnpm --filter @hyfib/notification-worker test
```

Expected: **PASS**, worker suite rising from 64 to 70.

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

Expected: build clean; lint 0 errors (4 pre-existing `no-explicit-any` warnings in this same file are acceptable); format clean; 0 test failures; persistence 51 pass / 0 skipped. If `format:check` flags a touched file, run `pnpm format` and re-run.

- [ ] **Step 6: Commit**

```bash
git add services/notification-worker/src/index.ts services/notification-worker/test/dispatch-campaign-stopped.test.js
git commit -m "feat(campaigns): pause and cancel stop already-queued sends"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 guard placement before `tryClaim` | Task 1 Step 3 |
| §2 recipient row left `pending` | Task 1 Step 3; asserted in Step 1 |
| §2 test sends exempt, no status read | Task 1 Step 1 (third test) and Step 3 |
| §2 no cache | Task 1 Step 3 (comment) |
| §2 only `running` proceeds, `undefined` skips | Task 1 Step 1 (loop covers `undefined`) |
| §3 all five test cases | Task 1 Step 1 |
| §4 validation | Task 1 Step 5 |

**Placeholder scan:** none.

**Type consistency:** `getStatus` returns `Promise<string | undefined>`, compared against the string literal `"running"`; `campaignStatus ?? "missing"` keeps the log field a string. `command.recipientId` is already optional on `CampaignDispatchRequest`, so the `if` narrows without a cast.

**One risk worth naming.** The test stubs `tryClaim` to return `false`, which makes the handler take its duplicate-suppression path and call `updateStatus`. That is why the skip-path assertion `updates` is empty only holds if the guard returns *before* `tryClaim` — if someone moves the guard after it, the duplicate path fires and the assertion catches it. That coupling is intentional, and this note exists so it is not "simplified" away.
