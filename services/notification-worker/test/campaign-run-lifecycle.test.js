import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import { campaignRepository, campaignRecipientRepository, channelRepository } from "@hyfib/persistence";
import { EventTopics } from "@hyfib/shared-core";

/**
 * The fan-out loop's lifecycle edges: honouring a pause mid-run, and writing the
 * terminal 'completed' status when the run genuinely drains.
 *
 * Both are reachable without the per-recipient path — a paused run never claims,
 * and a drained run claims an empty batch — so these tests stub only the two
 * repository calls the loop makes before touching a recipient. Same fake-bus +
 * monkey-patch technique as replay.test.js; no Postgres or Redis is touched.
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

function runEvent() {
  return {
    id: "env-run-1",
    topic: EventTopics.CampaignRunRequested,
    occurredAt: new Date().toISOString(),
    payload: {
      campaignId: "camp-1",
      tenantId: "t-1",
      channelId: "c-1",
      templateName: "promo",
      templateLanguage: "en_US",
      templateCategory: "marketing",
      templateStatus: "approved",
      ratePerMinute: 60
    }
  };
}

/** Installs stubs, runs the consumer, restores, and reports what was called. */
async function driveRun({ statuses, batches }) {
  const bus = createFakeBus();
  const originalGetStatus = campaignRepository.getStatus;
  const originalTransition = campaignRepository.transition;
  const originalClaim = campaignRecipientRepository.claimPendingBatch;
  // handleCampaignRun resolves its channel through the internal resolveSendChannel,
  // which reads channelRepository directly — the injectable WorkerDeps.resolveChannel
  // only covers inbound phone-number lookup and has no effect here.
  const originalGetCredentials = channelRepository.getCredentials;
  channelRepository.getCredentials = async () => ({
    id: "c-1",
    wabaId: "waba-1",
    phoneNumberId: "PN-1",
    accessToken: "tok"
  });

  const claims = [];
  const transitions = [];
  const remainingStatuses = [...statuses];
  const remainingBatches = [...batches];

  // Length-checked rather than `shift() ?? "running"`, which would convert a
  // deliberately-scripted undefined (campaign gone) back into "running".
  campaignRepository.getStatus = async () => (remainingStatuses.length > 0 ? remainingStatuses.shift() : "running");
  campaignRepository.transition = async (tenantId, id, from, to) => {
    transitions.push({ tenantId, id, from: [...from], to });
    return true;
  };
  campaignRecipientRepository.claimPendingBatch = async () => {
    claims.push(1);
    return remainingBatches.shift() ?? [];
  };

  try {
    registerWorkerConsumers({ eventBus: bus });
    const handleCampaignRun = bus.handlers.get(EventTopics.CampaignRunRequested);
    await handleCampaignRun(runEvent());
  } finally {
    campaignRepository.getStatus = originalGetStatus;
    campaignRepository.transition = originalTransition;
    campaignRecipientRepository.claimPendingBatch = originalClaim;
    channelRepository.getCredentials = originalGetCredentials;
  }
  return { claims: claims.length, transitions };
}

test("handleCampaignRun: a drained run does NOT complete the campaign itself", async () => {
  const { claims, transitions } = await driveRun({ statuses: ["running"], batches: [[]] });

  assert.equal(claims, 1, "a running campaign should claim once and find nothing");
  // An empty claim batch means "nothing unclaimed right now", not "finished":
  // recipients claimed a moment ago are still pending with their dispatch rows
  // queued. Completing here marked campaigns finished while their own sends were
  // in flight, and the dispatch-time guard then refused to send them.
  // complete_drained_campaigns owns this transition now.
  assert.deepEqual(transitions, [], "the fan-out loop must never write a terminal status");
});

test("handleCampaignRun: a paused campaign stops before claiming and is not marked completed", async () => {
  const { claims, transitions } = await driveRun({ statuses: ["paused"], batches: [[]] });

  assert.equal(claims, 0, "a paused campaign must not claim another batch");
  assert.deepEqual(transitions, [], "a paused campaign must never be marked completed");
});

test("handleCampaignRun: a campaign cancelled or deleted mid-run stops without completing", async () => {
  // getStatus returns undefined when the row is gone or belongs to another tenant.
  const { claims, transitions } = await driveRun({ statuses: [undefined], batches: [[]] });

  assert.equal(claims, 0);
  assert.deepEqual(transitions, []);
});
