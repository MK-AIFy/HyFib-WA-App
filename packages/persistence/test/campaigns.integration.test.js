import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  templateRepository,
  campaignRepository,
  contactRepository,
  campaignRecipientRepository,
  withTenant,
  closePool
} from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 021_campaign_recipient_claim.sql. CI provides it via
// service containers; locally run with RUN_DB_TESTS=1 (see rls.integration.test.js).
const skip = !process.env.RUN_DB_TESTS;

/**
 * Creates a tenant with an approved template, a campaign, and `recipientCount`
 * pending recipients. Each test gets its own tenant, so phone numbers only
 * need to be unique within the fixture.
 */
async function seedCampaign(label, recipientCount) {
  const tenant = await tenantRepository.create(`Claim ${label} Tenant`);
  const template = await templateRepository.create(tenant.id, {
    name: `claim_${label.toLowerCase()}_tpl`,
    category: "marketing",
    language: "en_US",
    body: "Hello {{1}}",
    status: "approved"
  });
  const campaign = await campaignRepository.create(tenant.id, {
    name: `Claim ${label} Campaign`,
    templateId: template.id
  });
  const contacts = [];
  for (let i = 0; i < recipientCount; i++) {
    const contact = await contactRepository.create(tenant.id, {
      phoneE164: `+1555${String(i).padStart(7, "0")}`
    });
    contacts.push({ id: contact.id, phoneE164: contact.phoneE164 });
  }
  await campaignRecipientRepository.insertBatch(tenant.id, campaign.id, contacts);
  return { tenant, campaign, contacts };
}

test("claimPendingBatch hands each recipient out exactly once", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Disjoint", 10);

  const first = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);
  const second = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);

  assert.equal(first.length, 4);
  assert.equal(second.length, 4);

  const firstIds = new Set(first.map((r) => r.id));
  const overlap = second.filter((r) => firstIds.has(r.id));
  assert.deepEqual(overlap, [], "a claimed recipient must not be handed out a second time");
});

test("claimPendingBatch converges to an empty batch", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Converge", 10);

  const seen = new Set();
  let batches = 0;
  for (;;) {
    const batch = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 4);
    if (batch.length === 0) break;
    for (const r of batch) seen.add(r.id);
    batches++;
    assert.ok(batches <= 5, "claim loop did not converge — it is re-returning claimed rows");
  }

  assert.equal(seen.size, 10, "every pending recipient should be claimed exactly once");
  assert.equal(batches, 3, "10 recipients at batchSize 4 should take 3 non-empty batches");
});

test("claimPendingBatch never claims a non-pending recipient", { skip }, async () => {
  const { tenant, campaign, contacts } = await seedCampaign("NonPending", 3);

  await withTenant(tenant.id, async (client) => {
    await client.query(
      `UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[0].id]
    );
    await client.query(
      `UPDATE campaign_recipients SET status = 'policy_skipped' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[1].id]
    );
  });

  const batch = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 10);

  assert.equal(batch.length, 1, "only the single remaining pending row should be claimed");
  assert.equal(batch[0].contactId, contacts[2].id);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
