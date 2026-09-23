import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  closePool
} from "../dist/index.js";

/**
 * WhatsApp's 24h session window belongs to the business phone number the customer messaged, not to the
 * customer. A contact who messaged channel A has no open window on channel B, and a send on B would be
 * rejected by Meta after the fact.
 *
 * lastInboundAt answers MAX(last_inbound_at) across every conversation the contact has, which is the wrong
 * scope for that decision; lastInboundAtForChannel is the scoped answer. These tests pin the difference so a
 * caller cannot quietly go back to the contact-wide one.
 *
 * Requires a live PostgreSQL with the schema applied. CI provides it; locally run with RUN_DB_TESTS=1.
 */
const skip = !process.env.RUN_DB_TESTS;

/** A tenant with two channels and one contact, plus a conversation on each channel. */
async function twoChannelFixture(label) {
  const unique = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const tenant = await tenantRepository.create(`Window Scope ${unique}`);
  const channelA = await channelRepository.create(tenant.id, {
    wabaId: `waba-a-${unique}`,
    phoneNumberId: `pn-a-${unique}`,
    displayPhoneNumber: "+15550000001"
  });
  const channelB = await channelRepository.create(tenant.id, {
    wabaId: `waba-b-${unique}`,
    phoneNumberId: `pn-b-${unique}`,
    displayPhoneNumber: "+15550000002"
  });
  const contact = await contactRepository.create(tenant.id, {
    phoneE164: `+1555${String(Date.now()).slice(-7)}`
  });
  const convA = await conversationRepository.findOrCreate(tenant.id, contact.id, channelA.id);
  const convB = await conversationRepository.findOrCreate(tenant.id, contact.id, channelB.id);
  return { tenant, channelA, channelB, contact, convA, convB };
}

test("lastInboundAtForChannel answers only for the channel asked about", { skip }, async () => {
  const f = await twoChannelFixture("scoped");

  // The customer messages channel A only.
  await conversationRepository.touchInbound(f.tenant.id, f.convA.id);

  const onA = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelA.id);
  const onB = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelB.id);

  assert.ok(onA instanceof Date, "channel A has an open window");
  assert.equal(onB, undefined, "channel B must not inherit channel A's window");
});

test("the contact-wide lookup is exactly the over-permissive answer this replaces", { skip }, async () => {
  // Pinned deliberately: lastInboundAt reports a window for a channel the customer never wrote to. That is
  // why it must not be used to authorise a send. If this ever stops being true, the callers can be simplified.
  const f = await twoChannelFixture("contact-wide");
  await conversationRepository.touchInbound(f.tenant.id, f.convA.id);

  const contactWide = await conversationRepository.lastInboundAt(f.tenant.id, f.contact.id);
  const scopedToB = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelB.id);

  assert.ok(contactWide instanceof Date, "the contact-wide lookup sees channel A's inbound");
  assert.equal(scopedToB, undefined, "while channel B correctly has no window");
});

test("a conversation that has never received an inbound reports no window", { skip }, async () => {
  const f = await twoChannelFixture("never");

  const onA = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelA.id);
  assert.equal(onA, undefined, "a conversation row alone is not an open window");
});

test("an unknown channel reports no window rather than throwing", { skip }, async () => {
  const f = await twoChannelFixture("unknown");
  await conversationRepository.touchInbound(f.tenant.id, f.convA.id);

  const unknownChannel = await conversationRepository.lastInboundAtForChannel(
    f.tenant.id,
    f.contact.id,
    "00000000-0000-0000-0000-0000000000ff"
  );
  assert.equal(unknownChannel, undefined);
});

test("each channel keeps its own window as the customer messages both", { skip }, async () => {
  const f = await twoChannelFixture("both");

  await conversationRepository.touchInbound(f.tenant.id, f.convA.id);
  const afterA = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelA.id);

  await conversationRepository.touchInbound(f.tenant.id, f.convB.id);
  const onB = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelB.id);
  const stillA = await conversationRepository.lastInboundAtForChannel(f.tenant.id, f.contact.id, f.channelA.id);

  assert.ok(onB instanceof Date, "channel B now has its own window");
  assert.equal(stillA?.getTime(), afterA?.getTime(), "and channel A's is untouched by it");
});

test("a re-registered phone number keeps its window, even though it is a new channel row", { skip }, async () => {
  // whatsapp_channels has no uniqueness on phone_number_id and create() does not check for duplicates, so
  // deactivating a number and registering it again leaves two rows for the same business number. Inbound and
  // outbound then disagree about which row is "the" channel: resolve_channel_by_phone_number_id takes the
  // OLDEST row and ignores is_active, while firstActive takes the oldest ACTIVE one. The customer's window is
  // Meta's, and it belongs to the phone number — not to whichever row we happen to be holding.
  const unique = `rereg-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const tenant = await tenantRepository.create(`Window Scope ${unique}`);
  const sharedPhoneNumberId = `pn-shared-${unique}`;

  const oldChannel = await channelRepository.create(tenant.id, {
    wabaId: `waba-old-${unique}`,
    phoneNumberId: sharedPhoneNumberId,
    displayPhoneNumber: "+15550000003"
  });
  const contact = await contactRepository.create(tenant.id, {
    phoneE164: `+1556${String(Date.now()).slice(-7)}`
  });

  // The customer messages in while the original row is the live one.
  const conv = await conversationRepository.findOrCreate(tenant.id, contact.id, oldChannel.id);
  await conversationRepository.touchInbound(tenant.id, conv.id);
  await channelRepository.update(tenant.id, oldChannel.id, { isActive: false });

  // The same number is registered again, producing a second row with no conversations of its own.
  const newChannel = await channelRepository.create(tenant.id, {
    wabaId: `waba-new-${unique}`,
    phoneNumberId: sharedPhoneNumberId,
    displayPhoneNumber: "+15550000003"
  });

  const window = await conversationRepository.lastInboundAtForChannel(tenant.id, contact.id, newChannel.id);
  assert.ok(
    window instanceof Date,
    "the window belongs to the phone number, so the new row must see the inbound the old row received"
  );
});

test("two rows sharing a phone_number_id but not a channel_type do not share a window", { skip }, async () => {
  // phone_number_id holds the Page ID on messenger/instagram rows — a different identifier space. A collision
  // across those spaces must not be read as "the same business number".
  const unique = `types-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const tenant = await tenantRepository.create(`Window Scope ${unique}`);
  const sharedId = `id-collision-${unique}`;

  const waChannel = await channelRepository.create(tenant.id, {
    wabaId: `waba-wa-${unique}`,
    phoneNumberId: sharedId,
    displayPhoneNumber: "+15550000004"
  });
  const fbChannel = await channelRepository.create(tenant.id, {
    wabaId: `waba-fb-${unique}`,
    phoneNumberId: sharedId,
    displayPhoneNumber: "+15550000005",
    channelType: "messenger"
  });
  const contact = await contactRepository.create(tenant.id, {
    phoneE164: `+1557${String(Date.now()).slice(-7)}`
  });

  const waConv = await conversationRepository.findOrCreate(tenant.id, contact.id, waChannel.id);
  await conversationRepository.touchInbound(tenant.id, waConv.id);

  const onWhatsApp = await conversationRepository.lastInboundAtForChannel(tenant.id, contact.id, waChannel.id);
  const onMessenger = await conversationRepository.lastInboundAtForChannel(tenant.id, contact.id, fbChannel.id);

  assert.ok(onWhatsApp instanceof Date, "the WhatsApp number has its window");
  assert.equal(onMessenger, undefined, "the Messenger page must not inherit it from a colliding identifier");
});

test("RLS: another tenant cannot read this tenant's window", { skip }, async () => {
  const f = await twoChannelFixture("rls");
  await conversationRepository.touchInbound(f.tenant.id, f.convA.id);
  const other = await tenantRepository.create(`Window Scope Outsider ${Date.now()}`);

  const leaked = await conversationRepository.lastInboundAtForChannel(other.id, f.contact.id, f.channelA.id);
  assert.equal(leaked, undefined, "the query must be tenant-isolated like every other conversation read");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
