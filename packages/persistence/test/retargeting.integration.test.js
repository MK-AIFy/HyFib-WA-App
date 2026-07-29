import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  templateRepository,
  campaignRepository,
  campaignRecipientRepository,
  contactRepository,
  consentRepository,
  linkClickRepository,
  segmentRepository,
  withTenant,
  closePool
} from "../dist/index.js";

// Retargeting segments (roadmap G6): campaign funnel status + click as a
// segment source. RUN_DB_TESTS=1 locally; CI service container.
const skip = !process.env.RUN_DB_TESTS;

async function contactWithConsent(tenantId, phone) {
  const contact = await contactRepository.create(tenantId, { phoneE164: phone });
  await consentRepository.grant(tenantId, contact.id, { source: "test", policyVersion: "v1" });
  return contact;
}

test("campaign funnel statuses + clicks drive segment resolution", { skip }, async () => {
  const tenant = await tenantRepository.create("Retarget Tenant");
  const template = await templateRepository.create(tenant.id, {
    name: `rt_tpl_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "x"
  });
  const campaign = await campaignRepository.create(tenant.id, { name: "RT source", templateId: template.id });

  const delivered = await contactWithConsent(tenant.id, "+15557770001");
  const readOnly = await contactWithConsent(tenant.id, "+15557770002");
  const failed = await contactWithConsent(tenant.id, "+15557770003");
  const outsider = await contactWithConsent(tenant.id, "+15557770004");

  await campaignRecipientRepository.insertBatch(tenant.id, campaign.id, [
    { id: delivered.id, phoneE164: delivered.phoneE164 },
    { id: readOnly.id, phoneE164: readOnly.phoneE164 },
    { id: failed.id, phoneE164: failed.phoneE164 }
  ]);
  const recipients = await campaignRecipientRepository.listByCampaign(tenant.id, campaign.id);
  const recipientIdOf = (contactId) => recipients.find((r) => r.contactId === contactId).id;
  await campaignRecipientRepository.updateStatus(tenant.id, recipientIdOf(delivered.id), { status: "delivered" });
  await campaignRecipientRepository.updateStatus(tenant.id, recipientIdOf(readOnly.id), { status: "read" });
  await campaignRecipientRepository.updateStatus(tenant.id, recipientIdOf(failed.id), { status: "failed" });

  // readOnly clicked a tracked link; the others did not.
  const token = `rt_tok_${Date.now()}`;
  await linkClickRepository.create(tenant.id, {
    token,
    destination: "https://example.com/p",
    campaignId: campaign.id,
    contactId: readOnly.id
  });
  // G6 consumes clicked_count; how it is incremented (the /r redirect fix,
  // PR #21) is a separate concern — set it directly within tenant scope.
  await withTenant(tenant.id, (client) =>
    client.query("UPDATE link_clicks SET clicked_count = 1 WHERE token = $1", [token])
  );

  const resolve = (definition) => segmentRepository.resolveContacts(tenant.id, definition);

  const everyone = await resolve({ campaign: { id: campaign.id } });
  assert.deepEqual(
    everyone.map((c) => c.phoneE164).sort(),
    ["+15557770001", "+15557770002", "+15557770003"],
    "no statuses = every recipient; outsider excluded"
  );

  const deliveredNotRead = await resolve({ campaign: { id: campaign.id, statuses: ["delivered"] } });
  assert.deepEqual(
    deliveredNotRead.map((c) => c.phoneE164),
    ["+15557770001"].map((p) => p)
  );

  const failedOnly = await resolve({ campaign: { id: campaign.id, statuses: ["failed"] } });
  assert.deepEqual(failedOnly.map((c) => c.phoneE164), ["+15557770003"]);

  const clicked = await resolve({ campaign: { id: campaign.id, clicked: true } });
  assert.deepEqual(clicked.map((c) => c.phoneE164), ["+15557770002"]);

  const ignoredLinks = await resolve({ campaign: { id: campaign.id, statuses: ["read"], clicked: false } });
  assert.deepEqual(ignoredLinks.map((c) => c.phoneE164), [], "read AND unclicked excludes the clicker");

  // Count + sample agree with the resolver (shared builder — no drift).
  assert.equal(await segmentRepository.previewCount(tenant.id, { campaign: { id: campaign.id } }), 3);
  const sample = await segmentRepository.resolveContactsSample(tenant.id, { campaign: { id: campaign.id } }, 2);
  assert.equal(sample.length, 2);

  void outsider;
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
