import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import { campaignRepository, campaignSendLog, outboxRepository } from "@hyfib/persistence";
import { EventTopics } from "@hyfib/shared-core";

/**
 * Scheduling replaced the blocking token bucket, which fixed head-of-line
 * blocking but turned a hard rate cap into an advisory one: if the relay falls
 * behind, every backlogged row becomes eligible at once and can burst past the
 * campaign's configured ratePerMinute.
 *
 * The cap is restored here without reintroducing any sleeping. A dispatch that
 * would exceed the budget is re-queued for later rather than slept on, so the
 * relay stays free and the campaign still paces.
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

/** Redis stand-in whose INCR always exceeds any budget, forcing the over-limit path. */
function createSaturatedRedis() {
  return {
    async incr() {
      return 1_000_000;
    },
    async pexpire() {
      return 1;
    }
  };
}

/** Redis stand-in that always has budget available. */
function createIdleRedis() {
  return {
    async incr() {
      return 1;
    },
    async pexpire() {
      return 1;
    }
  };
}

function dispatchEvent(overrides = {}) {
  return {
    id: "env-rate-1",
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
      ratePerMinute: 60,
      ...overrides
    }
  };
}

async function driveDispatch({ redis, payload = {} }) {
  const bus = createFakeBus();
  const originalGetStatus = campaignRepository.getStatus;
  const originalTryClaim = campaignSendLog.tryClaim;
  const originalEnqueueOwn = outboxRepository.enqueueOwn;

  let claims = 0;
  const deferrals = [];

  campaignRepository.getStatus = async () => "running";
  campaignSendLog.tryClaim = async () => {
    claims++;
    return false; // Stop before the send path; not under test here.
  };
  outboxRepository.enqueueOwn = async (tenantId, input) => {
    deferrals.push({ tenantId, input });
  };

  try {
    registerWorkerConsumers({ eventBus: bus, redis });
    const handleDispatch = bus.handlers.get(EventTopics.CampaignDispatchRequested);
    await handleDispatch(dispatchEvent(payload));
  } finally {
    campaignRepository.getStatus = originalGetStatus;
    campaignSendLog.tryClaim = originalTryClaim;
    outboxRepository.enqueueOwn = originalEnqueueOwn;
  }
  return { claims, deferrals };
}

test("handleDispatch: an over-budget send is rescheduled, not sent and not slept on", async () => {
  const before = Date.now();
  const { claims, deferrals } = await driveDispatch({ redis: createSaturatedRedis() });

  assert.equal(claims, 0, "an over-budget send must not consume the exactly-once send-log claim");
  assert.equal(deferrals.length, 1, "the send must be re-queued rather than dropped");

  const deferred = deferrals[0];
  assert.equal(deferred.tenantId, "t-1");
  assert.equal(deferred.input.topic, EventTopics.CampaignDispatchRequested);
  assert.equal(deferred.input.payload.recipientId, "rec-1", "the same recipient must be retried");
  assert.ok(
    new Date(deferred.input.nextAttemptAt).getTime() > before,
    "the retry must be scheduled into the future, which is what paces it without blocking"
  );
});

test("handleDispatch: a send within budget proceeds normally", async () => {
  const { claims, deferrals } = await driveDispatch({ redis: createIdleRedis() });

  assert.equal(claims, 1, "a send within budget must reach the send-log claim as before");
  assert.deepEqual(deferrals, [], "nothing should be deferred when there is budget");
});

test("handleDispatch: a test send carries no rate and is never capped", async () => {
  // POST /campaigns/{id}/dispatch is a one-off operator action, not paced work.
  const { claims, deferrals } = await driveDispatch({
    redis: createSaturatedRedis(),
    payload: { recipientId: undefined, ratePerMinute: undefined }
  });

  assert.equal(claims, 1, "a test send must not be rate-capped");
  assert.deepEqual(deferrals, []);
});
