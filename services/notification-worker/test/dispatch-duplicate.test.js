import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import { campaignSendLog, campaignRecipientRepository, campaignRepository } from "@hyfib/persistence";
import { EventTopics } from "@hyfib/shared-core";

/**
 * handleDispatch's dedupe branch used to `return` without touching the recipient
 * row, leaving it 'pending' forever. That was latent until campaign_recipients
 * gained a stale-claim reclaim (migration 021): a permanently-pending row is now
 * re-claimed and re-enqueued every stale window, so the suppression must be
 * recorded on the row or the campaign never drains.
 *
 * Same technique as replay.test.js: capture the real consumer via a fake bus and
 * monkey-patch the shared persistence singletons — no Postgres is touched.
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
    id: "env-dup-1",
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

test("handleDispatch: a suppressed duplicate marks the recipient off pending", async () => {
  const bus = createFakeBus();
  const originalTryClaim = campaignSendLog.tryClaim;
  const originalUpdateStatus = campaignRecipientRepository.updateStatus;
  const originalGetStatus = campaignRepository.getStatus;
  const updates = [];

  // A fan-out dispatch is now gated on campaign status before the send-log
  // claim, so this must report 'running' to reach the duplicate path at all.
  campaignRepository.getStatus = async () => "running";
  campaignSendLog.tryClaim = async () => false;
  campaignRecipientRepository.updateStatus = async (tenantId, recipientId, update) => {
    updates.push({ tenantId, recipientId, update });
  };

  try {
    registerWorkerConsumers({ eventBus: bus });
    const handleDispatch = bus.handlers.get(EventTopics.CampaignDispatchRequested);

    await handleDispatch(dispatchEvent());

    assert.equal(updates.length, 1, "a suppressed duplicate must record the outcome on the recipient row");
    assert.equal(updates[0].tenantId, "t-1");
    assert.equal(updates[0].recipientId, "rec-1");
    assert.equal(updates[0].update.status, "policy_skipped");
    assert.equal(updates[0].update.skipReason, "duplicate_send_suppressed");
    assert.equal(
      updates[0].update.onlyIfStatus,
      "pending",
      "the write must be guarded so an outbox redelivery cannot downgrade a sent/delivered row"
    );
  } finally {
    campaignSendLog.tryClaim = originalTryClaim;
    campaignRecipientRepository.updateStatus = originalUpdateStatus;
    campaignRepository.getStatus = originalGetStatus;
  }
});

test("handleDispatch: a suppressed duplicate with no recipientId writes nothing", async () => {
  const bus = createFakeBus();
  const originalTryClaim = campaignSendLog.tryClaim;
  const originalUpdateStatus = campaignRecipientRepository.updateStatus;
  const updates = [];

  campaignSendLog.tryClaim = async () => false;
  campaignRecipientRepository.updateStatus = async (...args) => {
    updates.push(args);
  };

  try {
    registerWorkerConsumers({ eventBus: bus });
    const handleDispatch = bus.handlers.get(EventTopics.CampaignDispatchRequested);

    // A single-number test send (POST /campaigns/{id}/dispatch) carries no recipientId.
    await handleDispatch(dispatchEvent({ recipientId: undefined }));

    assert.deepEqual(updates, [], "a test send has no funnel row to update");
  } finally {
    campaignSendLog.tryClaim = originalTryClaim;
    campaignRecipientRepository.updateStatus = originalUpdateStatus;
  }
});

test("handleDispatch: a recipient-row write failure never breaks the suppression path", async () => {
  const bus = createFakeBus();
  const originalTryClaim = campaignSendLog.tryClaim;
  const originalUpdateStatus = campaignRecipientRepository.updateStatus;
  const originalGetStatus = campaignRepository.getStatus;

  campaignRepository.getStatus = async () => "running";
  campaignSendLog.tryClaim = async () => false;
  campaignRecipientRepository.updateStatus = async () => {
    throw new Error("db_unavailable");
  };

  try {
    registerWorkerConsumers({ eventBus: bus });
    const handleDispatch = bus.handlers.get(EventTopics.CampaignDispatchRequested);

    // Must not throw: rethrowing would send the event back for broker retry and
    // re-suppress forever. Best-effort bookkeeping, exactly like the quota gate.
    await handleDispatch(dispatchEvent());
  } finally {
    campaignSendLog.tryClaim = originalTryClaim;
    campaignRecipientRepository.updateStatus = originalUpdateStatus;
    campaignRepository.getStatus = originalGetStatus;
  }
});
