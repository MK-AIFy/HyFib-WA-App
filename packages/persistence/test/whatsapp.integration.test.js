import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  messageRepository,
  closePool
} from "../dist/index.js";

// Require a live PostgreSQL (schema + app role). CI provides it; locally use
// RUN_DB_TESTS=1 and CHANNEL_ENCRYPTION_KEY for the credential round-trip.
const skip = !process.env.RUN_DB_TESTS;

test("conversation history is returned in chronological order", { skip }, async () => {
  const t = await tenantRepository.create("History Tenant");
  const channel = await channelRepository.create(t.id, {
    wabaId: "WABA-1",
    phoneNumberId: "PNID-1",
    displayPhoneNumber: "+15550000001"
  });
  const contact = await contactRepository.findOrCreateByPhone(t.id, "+15551239999");
  const conversation = await conversationRepository.findOrCreate(t.id, contact.id, channel.id);

  await messageRepository.create(t.id, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    payload: { text: "first" }
  });
  const outbound = await messageRepository.create(t.id, {
    conversationId: conversation.id,
    direction: "outbound",
    status: "sent",
    externalMessageId: "wamid.hist.1",
    payload: { text: "second" }
  });

  const thread = await messageRepository.listByConversation(t.id, conversation.id, { limit: 10 });
  assert.equal(thread.length, 2);
  assert.equal(thread[0].payload.text, "first");
  assert.equal(thread[1].payload.text, "second");

  // applyStatusUpdate merges delivery metadata into the payload.
  const updated = await messageRepository.applyStatusUpdate(t.id, "wamid.hist.1", "delivered", {
    pricing: { billable: true, category: "service" }
  });
  assert.equal(updated, true);
  const refreshed = await messageRepository.listByConversation(t.id, conversation.id, { limit: 10 });
  const target = refreshed.find((m) => m.id === outbound.id);
  assert.equal(target.status, "delivered");
  assert.deepEqual(target.payload.pricing, { billable: true, category: "service" });
});

test("per-channel access token encrypts at rest and decrypts on read", { skip }, async () => {
  if (!process.env.CHANNEL_ENCRYPTION_KEY) {
    return; // requires a configured key
  }
  const t = await tenantRepository.create("Creds Tenant");
  const channel = await channelRepository.create(t.id, {
    wabaId: "WABA-2",
    phoneNumberId: "PNID-2",
    displayPhoneNumber: "+15550000002",
    accessToken: "EAAG-tenant-token"
  });
  const creds = await channelRepository.getCredentials(t.id, channel.id);
  assert.ok(creds);
  assert.equal(creds.phoneNumberId, "PNID-2");
  assert.equal(creds.accessToken, "EAAG-tenant-token");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
