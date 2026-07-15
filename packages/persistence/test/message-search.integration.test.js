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

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 020_message_search.sql (the pg_trgm expression
// index on messages). CI provides it via service containers; locally run
// with RUN_DB_TESTS=1 (see rls.integration.test.js).
const skip = !process.env.RUN_DB_TESTS;

async function seedTenantWithChannel(tenantName) {
  const tenant = await tenantRepository.create(tenantName);
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `WABA-${tenantName}`,
    phoneNumberId: `PNID-${tenantName}`,
    displayPhoneNumber: "+15550000099"
  });
  return { tenant, channel };
}

async function seedConversation(tenant, channel, contactInput) {
  const contact = await contactRepository.create(tenant.id, contactInput);
  const conversation = await conversationRepository.findOrCreate(tenant.id, contact.id, channel.id);
  return { contact, conversation };
}

async function seedMessage(tenant, conversation, payload, overrides = {}) {
  return messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "delivered",
    payload
  });
}

test(
  "substring hit in the middle of a word is returned with text + contact context; total is correct",
  { skip },
  async () => {
    const { tenant, channel } = await seedTenantWithChannel("Msg Search Substring");
    const { contact, conversation } = await seedConversation(tenant, channel, {
      phoneE164: "+15551230001",
      firstName: "Hyper",
      lastName: "Active"
    });
    await seedMessage(tenant, conversation, { text: "the system is hyperactive today" });
    // Unrelated message in a different conversation should not match.
    const { conversation: other } = await seedConversation(tenant, channel, {
      phoneE164: "+15551230002",
      firstName: "Quiet",
      lastName: "One"
    });
    await seedMessage(tenant, other, { text: "nothing interesting here" });

    const { items, total } = await messageRepository.search(tenant.id, { q: "peract" });
    assert.equal(total, 1, "only the message containing the substring should match");
    assert.equal(items.length, 1);
    assert.equal(items[0].text, "the system is hyperactive today");
    assert.equal(items[0].conversationId, conversation.id);
    assert.equal(items[0].contactName, "Hyper Active");
    assert.equal(items[0].contactPhone, contact.phoneE164);
  }
);

test("match is case-insensitive", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Msg Search CaseInsensitive");
  const { conversation } = await seedConversation(tenant, channel, {
    phoneE164: "+15551240001",
    firstName: "Case",
    lastName: "Test"
  });
  await seedMessage(tenant, conversation, { text: "Important Update About Your Order" });

  const { items, total } = await messageRepository.search(tenant.id, { q: "PORTANT" });
  assert.equal(total, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Important Update About Your Order");
});

test("conversationId scopes results to only that conversation's hits", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Msg Search Scoping");
  const { conversation: convA } = await seedConversation(tenant, channel, {
    phoneE164: "+15551250001",
    firstName: "Conv",
    lastName: "A"
  });
  const { conversation: convB } = await seedConversation(tenant, channel, {
    phoneE164: "+15551250002",
    firstName: "Conv",
    lastName: "B"
  });
  await seedMessage(tenant, convA, { text: "a shared keyword appears here" });
  await seedMessage(tenant, convB, { text: "a shared keyword appears here too" });

  const unscoped = await messageRepository.search(tenant.id, { q: "shared" });
  assert.equal(unscoped.total, 2, "unscoped search should see both conversations' hits");

  const scoped = await messageRepository.search(tenant.id, { q: "shared", conversationId: convA.id });
  assert.equal(scoped.total, 1, "scoped search should only count the target conversation's hit");
  assert.equal(scoped.items.length, 1);
  assert.equal(scoped.items[0].conversationId, convA.id);
});

test(
  "messages without payload.text never match; a literal % in q is treated literally, not as a wildcard",
  { skip },
  async () => {
    const { tenant, channel } = await seedTenantWithChannel("Msg Search NoTextAndPercent");
    const { conversation } = await seedConversation(tenant, channel, {
      phoneE164: "+15551260001",
      firstName: "Media",
      lastName: "Only"
    });
    // Media-only message: no `text` key in payload at all.
    await seedMessage(tenant, conversation, { mediaId: "asset-123", mimeType: "image/jpeg" });
    // Contains the literal substring "50%".
    await seedMessage(tenant, conversation, { text: "Get 50% off now" });
    // Contains "50" but NOT the literal "50%" — if the raw q were passed
    // through unescaped, "%50%%" would incorrectly match this row too.
    await seedMessage(tenant, conversation, { text: "Best 500 choice" });

    const broadSearch = await messageRepository.search(tenant.id, { q: "asset" });
    assert.equal(broadSearch.total, 0, "media-only messages with no payload.text should never match");

    const percentSearch = await messageRepository.search(tenant.id, { q: "50%" });
    assert.equal(percentSearch.total, 1, "only the message with the literal '50%' substring should match");
    assert.equal(percentSearch.items.length, 1);
    assert.equal(percentSearch.items[0].text, "Get 50% off now");
  }
);

test("results are ordered newest-first, and limit/offset paging works", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Msg Search Paging");
  const { conversation } = await seedConversation(tenant, channel, {
    phoneE164: "+15551270001",
    firstName: "Page",
    lastName: "Test"
  });

  const texts = ["pagetoken message one", "pagetoken message two", "pagetoken message three"];
  const created = [];
  for (const text of texts) {
    created.push(await seedMessage(tenant, conversation, { text }));
    // Separate created_at values enough to make ordering deterministic.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const all = await messageRepository.search(tenant.id, { q: "pagetoken" });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 3);
  assert.deepEqual(
    all.items.map((m) => m.id),
    [created[2].id, created[1].id, created[0].id],
    "newest message should come first"
  );

  const page1 = await messageRepository.search(tenant.id, { q: "pagetoken", limit: 2, offset: 0 });
  assert.equal(page1.total, 3, "total should reflect the full match count regardless of paging");
  assert.equal(page1.items.length, 2);
  assert.deepEqual(
    page1.items.map((m) => m.id),
    [created[2].id, created[1].id]
  );

  const page2 = await messageRepository.search(tenant.id, { q: "pagetoken", limit: 2, offset: 2 });
  assert.equal(page2.total, 3);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0].id, created[0].id);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
