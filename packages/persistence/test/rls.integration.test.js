import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  contactRepository,
  outboxRepository,
  withTenant,
  closePool
} from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied.
// CI provides it via service containers; locally run with RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("row-level security isolates tenant data", { skip }, async () => {
  const a = await tenantRepository.create("Tenant A");
  const b = await tenantRepository.create("Tenant B");

  await contactRepository.create(a.id, { phoneE164: "+15551230001" });
  await contactRepository.create(a.id, { phoneE164: "+15551230002" });
  await contactRepository.create(b.id, { phoneE164: "+15551230003" });

  assert.equal((await contactRepository.list(a.id)).length, 2);
  assert.equal((await contactRepository.list(b.id)).length, 1);

  // Raw count under tenant B context must only see B's rows (RLS enforced in DB).
  const count = await withTenant(b.id, async (client) => {
    const result = await client.query("SELECT COUNT(*)::int AS n FROM contacts");
    return result.rows[0].n;
  });
  assert.equal(count, 1);
});

test("transactional outbox round-trips through claim/markProcessed", { skip }, async () => {
  const t = await tenantRepository.create("Outbox Tenant");
  await withTenant(t.id, async (client) => {
    await outboxRepository.enqueue(client, t.id, {
      topic: "campaign.dispatch.requested",
      payload: { hello: "world" }
    });
  });

  const claimed = await outboxRepository.claim(10);
  const row = claimed.find((r) => r.tenant_id === t.id);
  assert.ok(row, "expected to claim the enqueued row");
  assert.equal(row.topic, "campaign.dispatch.requested");
  await outboxRepository.markProcessed(row.id);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
