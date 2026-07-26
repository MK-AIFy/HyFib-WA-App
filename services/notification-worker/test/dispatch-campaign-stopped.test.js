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
