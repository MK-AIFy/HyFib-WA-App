import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  closePool
} from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 017_conversation_search.sql (pg_trgm indexes). CI
// provides it via service containers; locally run with RUN_DB_TESTS=1 (see
// rls.integration.test.js).
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

test("q matches a first-name fragment case-insensitively", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Search Tenant Name");
  const { conversation: target } = await seedConversation(tenant, channel, {
    phoneE164: "+15552220001",
    firstName: "Aphrodite",
    lastName: "Smith"
  });
  await seedConversation(tenant, channel, {
    phoneE164: "+15552220002",
    firstName: "Zephyr",
    lastName: "Jones"
  });

  const { items, total } = await conversationRepository.list(tenant.id, { q: "PHRO" });
  assert.equal(total, 1, "only the matching conversation should be counted");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, target.id);
});

test("q matches a phone fragment from the middle digits", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Search Tenant Phone");
  const { conversation: target } = await seedConversation(tenant, channel, {
    phoneE164: "+15559998888",
    firstName: "Foo",
    lastName: "Bar"
  });
  await seedConversation(tenant, channel, {
    phoneE164: "+15551112222",
    firstName: "Baz",
    lastName: "Qux"
  });

  const { items, total } = await conversationRepository.list(tenant.id, { q: "9998" });
  assert.equal(total, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, target.id);
});

test("q with no match returns empty items and total 0", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Search Tenant NoMatch");
  await seedConversation(tenant, channel, {
    phoneE164: "+15553330001",
    firstName: "Someone",
    lastName: "Real"
  });

  const { items, total } = await conversationRepository.list(tenant.id, { q: "zzz-does-not-exist-zzz" });
  assert.equal(total, 0);
  assert.deepEqual(items, []);
});

test("q containing a literal % is escaped, not treated as a SQL wildcard", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Search Tenant Percent");
  // Contains the literal substring "50%".
  const { conversation: target } = await seedConversation(tenant, channel, {
    phoneE164: "+15554440001",
    firstName: "Get50%OffNow",
    lastName: ""
  });
  // Contains "50" but NOT the literal "50%" — if escapeLike were broken and
  // "%" were passed through as a raw wildcard, this row would incorrectly
  // match too (since %50%% collapses to matching anything containing "50").
  await seedConversation(tenant, channel, {
    phoneE164: "+15554440002",
    firstName: "Best500Choice",
    lastName: ""
  });

  const { items, total } = await conversationRepository.list(tenant.id, { q: "50%" });
  assert.equal(total, 1, "only the row with the literal '50%' substring should match");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, target.id);
});

test("existing no-q behavior is unchanged: list returns all conversations for the tenant", { skip }, async () => {
  const { tenant, channel } = await seedTenantWithChannel("Search Tenant AllList");
  await seedConversation(tenant, channel, { phoneE164: "+15555550001", firstName: "One", lastName: "A" });
  await seedConversation(tenant, channel, { phoneE164: "+15555550002", firstName: "Two", lastName: "B" });
  await seedConversation(tenant, channel, { phoneE164: "+15555550003", firstName: "Three", lastName: "C" });

  const { items, total } = await conversationRepository.list(tenant.id, {});
  assert.equal(total, 3);
  assert.equal(items.length, 3);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
