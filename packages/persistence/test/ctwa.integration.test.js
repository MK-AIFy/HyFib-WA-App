import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  messageRepository,
  attributionRepository,
  closePool
} from "../dist/index.js";

// CTWA attribution (roadmap G18): aggregates the referral objects the
// ingestor has always persisted on inbound messages. RUN_DB_TESTS=1 locally.
const skip = !process.env.RUN_DB_TESTS;

test("ctwaSources groups inbound referrals by ad source", { skip }, async () => {
  const tenant = await tenantRepository.create("CTWA Tenant");
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-ctwa-${Date.now()}`,
    phoneNumberId: `pn-ctwa-${Date.now()}`,
    displayPhoneNumber: "+15550301111"
  });
  const contactA = await contactRepository.create(tenant.id, { phoneE164: "+15550302222" });
  const contactB = await contactRepository.create(tenant.id, { phoneE164: "+15550303333" });
  const convA = await conversationRepository.findOrCreate(tenant.id, contactA.id, channel.id);
  const convB = await conversationRepository.findOrCreate(tenant.id, contactB.id, channel.id);

  const adReferral = {
    source_id: "ad-1001",
    source_type: "ad",
    source_url: "https://fb.me/ad-1001",
    headline: "Monsoon sale"
  };
  await messageRepository.create(tenant.id, {
    conversationId: convA.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "Saw your ad", referral: adReferral }
  });
  await messageRepository.create(tenant.id, {
    conversationId: convA.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "Is it still on?", referral: adReferral }
  });
  await messageRepository.create(tenant.id, {
    conversationId: convB.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "From the ad", referral: adReferral }
  });
  // Organic message and an outbound one must not count.
  await messageRepository.create(tenant.id, {
    conversationId: convB.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "hello organically" }
  });
  await messageRepository.create(tenant.id, {
    conversationId: convB.id,
    direction: "outbound",
    status: "sent",
    payload: { kind: "text", text: "hi", referral: adReferral }
  });

  const sources = await attributionRepository.ctwaSources(tenant.id, 30);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceId, "ad-1001");
  assert.equal(sources[0].sourceType, "ad");
  assert.equal(sources[0].headline, "Monsoon sale");
  assert.equal(sources[0].messages, 3);
  assert.equal(sources[0].conversations, 2);
  assert.ok(sources[0].firstSeen <= sources[0].lastSeen);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
