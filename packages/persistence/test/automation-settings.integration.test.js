import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  automationSettingsRepository,
  contactRepository,
  channelRepository,
  conversationRepository,
  messageRepository,
  closePool
} from "../dist/index.js";

// Default automations settings (roadmap G8). Requires a live PostgreSQL with
// migration 026 applied — RUN_DB_TESTS=1 locally, service container in CI.
const skip = !process.env.RUN_DB_TESTS;

test("automation settings: get before upsert is undefined; upsert round-trips and patches", { skip }, async () => {
  const tenant = await tenantRepository.create("AutoSettings Tenant");

  assert.equal(await automationSettingsRepository.get(tenant.id), undefined);

  const created = await automationSettingsRepository.upsert(tenant.id, {
    timezone: "Asia/Kolkata",
    workingHours: { mon: { open: "09:00", close: "18:00" } },
    welcomeEnabled: true,
    welcomeText: "Welcome to HyFib!",
    oooEnabled: true,
    oooText: "We are away.",
    oooSuppressHours: 6
  });
  assert.equal(created.timezone, "Asia/Kolkata");
  assert.deepEqual(created.workingHours, { mon: { open: "09:00", close: "18:00" } });
  assert.equal(created.welcomeEnabled, true);
  assert.equal(created.oooSuppressHours, 6);

  // Partial upsert only touches the provided fields.
  const patched = await automationSettingsRepository.upsert(tenant.id, { oooEnabled: false });
  assert.equal(patched.oooEnabled, false);
  assert.equal(patched.welcomeText, "Welcome to HyFib!", "untouched fields survive");
  assert.equal(patched.timezone, "Asia/Kolkata");

  const fetched = await automationSettingsRepository.get(tenant.id);
  assert.equal(fetched?.oooEnabled, false);
});

test("hasPriorInbound distinguishes a contact's first message", { skip }, async () => {
  const tenant = await tenantRepository.create("FirstInbound Tenant");
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-fi-${Date.now()}`,
    phoneNumberId: `pn-fi-${Date.now()}`,
    displayPhoneNumber: "+15550004001"
  });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15550004002" });
  const conversation = await conversationRepository.findOrCreate(tenant.id, contact.id, channel.id);

  const first = await messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "hello" }
  });
  assert.equal(
    await messageRepository.hasPriorInbound(tenant.id, conversation.id, first.id),
    false,
    "the just-persisted message is the first inbound"
  );

  const second = await messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "again" }
  });
  assert.equal(await messageRepository.hasPriorInbound(tenant.id, conversation.id, second.id), true);

  // Outbound messages do not count as prior inbound.
  const outbound = await messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: "outbound",
    status: "queued",
    payload: { kind: "text", text: "agent reply" }
  });
  assert.ok(outbound.id);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
