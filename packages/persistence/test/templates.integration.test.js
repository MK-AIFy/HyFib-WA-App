import test from "node:test";
import assert from "node:assert/strict";
import { tenantRepository, templateRepository, campaignRepository, closePool } from "../dist/index.js";

// Requires a live PostgreSQL with migrations applied (024_template_lifecycle.sql
// adds templates.meta_template_id) — run `pnpm migrate` first.
// CI provides it via service containers; locally run with RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("template lifecycle: create → markSubmitted → update → delete", { skip }, async () => {
  const tenant = await tenantRepository.create("Template Lifecycle Tenant");
  const created = await templateRepository.create(tenant.id, {
    name: `tpl_lifecycle_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "Hello {{1}}"
  });
  assert.equal(created.status, "pending");
  assert.equal(created.metaTemplateId, null, "fresh local template has no meta id");

  const submitted = await templateRepository.markSubmitted(tenant.id, created.id, "meta-123");
  assert.equal(submitted?.metaTemplateId, "meta-123");
  assert.equal(submitted?.status, "pending");

  const updated = await templateRepository.update(tenant.id, created.id, {
    body: "Hi {{1}}",
    category: "utility"
  });
  assert.equal(updated?.body, "Hi {{1}}");
  assert.equal(updated?.category, "utility");
  assert.equal(updated?.metaTemplateId, "meta-123", "update must not clear the meta id");

  const noop = await templateRepository.update(tenant.id, created.id, {});
  assert.equal(noop?.body, "Hi {{1}}", "empty patch returns the current row unchanged");

  const statusOnly = await templateRepository.update(tenant.id, created.id, { status: "paused" });
  assert.equal(statusOnly?.status, "paused");

  assert.equal(await templateRepository.delete(tenant.id, created.id), true);
  assert.equal(await templateRepository.getById(tenant.id, created.id), undefined);
  assert.equal(await templateRepository.delete(tenant.id, created.id), false, "second delete finds nothing");
});

test("delete propagates the FK violation when a campaign references the template", { skip }, async () => {
  const tenant = await tenantRepository.create("Template FK Tenant");
  const template = await templateRepository.create(tenant.id, {
    name: `tpl_fk_${Date.now()}`,
    category: "utility",
    language: "en",
    body: "In use"
  });
  await campaignRepository.create(tenant.id, { name: "FK campaign", templateId: template.id });

  await assert.rejects(
    () => templateRepository.delete(tenant.id, template.id),
    (error) => error?.code === "23503",
    "expected the Postgres FK violation to surface for the gateway to map to 409"
  );
});

test("upsertFromMeta links meta_template_id and preserves it when later pulls omit it", { skip }, async () => {
  const tenant = await tenantRepository.create("Template Upsert Tenant");
  const name = `tpl_sync_${Date.now()}`;

  const first = await templateRepository.upsertFromMeta(tenant.id, {
    name,
    language: "en",
    status: "approved",
    category: "utility",
    body: "Synced",
    metaTemplateId: "meta-999"
  });
  assert.equal(first.metaTemplateId, "meta-999");

  const second = await templateRepository.upsertFromMeta(tenant.id, {
    name,
    language: "en",
    status: "paused",
    category: "utility",
    body: "Synced v2"
  });
  assert.equal(second.metaTemplateId, "meta-999", "COALESCE must keep the existing meta id");
  assert.equal(second.status, "paused");
  assert.equal(second.body, "Synced v2");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
