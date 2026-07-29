import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  templateRepository,
  campaignRepository,
  campaignRecipientRepository,
  contactRepository,
  linkClickRepository,
  closePool
} from "../dist/index.js";

// Campaign analytics export (roadmap G10): full-funnel listing + click stats.
// Requires a live PostgreSQL with migrations applied (RUN_DB_TESTS=1 locally).
const skip = !process.env.RUN_DB_TESTS;

test("listForExport returns the whole funnel in insertion order", { skip }, async () => {
  const tenant = await tenantRepository.create("Export Funnel Tenant");
  const template = await templateRepository.create(tenant.id, {
    name: `exp_tpl_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "x"
  });
  const campaign = await campaignRepository.create(tenant.id, { name: "Export campaign", templateId: template.id });
  const a = await contactRepository.create(tenant.id, { phoneE164: "+15553330001" });
  const b = await contactRepository.create(tenant.id, { phoneE164: "+15553330002" });
  await campaignRecipientRepository.insertBatch(tenant.id, campaign.id, [
    { id: a.id, phoneE164: a.phoneE164 },
    { id: b.id, phoneE164: b.phoneE164 }
  ]);

  const rows = await campaignRecipientRepository.listForExport(tenant.id, campaign.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.phoneE164),
    ["+15553330001", "+15553330002"]
  );
  assert.equal(rows[0].status, "pending");
});

test("campaignClickStats aggregates tracked/clicked/total/unique", { skip }, async () => {
  const tenant = await tenantRepository.create("Export Clicks Tenant");
  const template = await templateRepository.create(tenant.id, {
    name: `exp_clk_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "x"
  });
  const campaign = await campaignRepository.create(tenant.id, { name: "Clicks campaign", templateId: template.id });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15553330003" });

  const clickedToken = `tok_clicked_${Date.now()}`;
  const ignoredToken = `tok_ignored_${Date.now()}`;
  await linkClickRepository.create(tenant.id, {
    token: clickedToken,
    destination: "https://example.com/a",
    campaignId: campaign.id,
    contactId: contact.id
  });
  await linkClickRepository.create(tenant.id, {
    token: ignoredToken,
    destination: "https://example.com/b",
    campaignId: campaign.id,
    contactId: contact.id
  });
  await linkClickRepository.recordClick(clickedToken);
  await linkClickRepository.recordClick(clickedToken);

  const stats = await linkClickRepository.campaignClickStats(tenant.id, campaign.id);
  assert.deepEqual(stats, { trackedLinks: 2, clickedLinks: 1, totalClicks: 2, uniqueClickers: 1 });

  const none = await linkClickRepository.campaignClickStats(tenant.id, "00000000-0000-0000-0000-000000000099");
  assert.deepEqual(none, { trackedLinks: 0, clickedLinks: 0, totalClicks: 0, uniqueClickers: 0 });
});

test("recordClick works WITHOUT tenant context (public /r redirect regression)", { skip }, async () => {
  // The redirect route has no authenticated tenant. Before migration 025 the
  // bare UPDATE was silently filtered to zero rows by FORCE RLS: no click was
  // recorded and the route 404'd every tracked shortlink.
  const tenant = await tenantRepository.create("Redirect Regression Tenant");
  const token = `tok_public_${Date.now()}`;
  await linkClickRepository.create(tenant.id, { token, destination: "https://example.com/promo" });

  const click = await linkClickRepository.recordClick(token);
  assert.ok(click, "recordClick must resolve the token with no tenant context");
  assert.equal(click.destination, "https://example.com/promo");
  assert.equal(click.tenantId, tenant.id);

  assert.equal(await linkClickRepository.recordClick(`missing_${Date.now()}`), undefined);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
