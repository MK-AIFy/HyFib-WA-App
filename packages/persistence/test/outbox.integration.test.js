import test from "node:test";
import assert from "node:assert/strict";
import { tenantRepository, outboxRepository, withTenant, closePool } from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 015_outbox_durability.sql. CI provides it via service
// containers; locally run with RUN_DB_TESTS=1 (see rls.integration.test.js).
const skip = !process.env.RUN_DB_TESTS;

test("outbox_claim only returns rows whose next_attempt_at has passed", { skip }, async () => {
  const t = await tenantRepository.create("Outbox Durability Tenant A");
  let futureId;
  let pastId;
  await withTenant(t.id, async (client) => {
    await outboxRepository.enqueue(client, t.id, {
      topic: "durability.future",
      payload: { case: "future" }
    });
    await outboxRepository.enqueue(client, t.id, {
      topic: "durability.past",
      payload: { case: "past" }
    });
    const rows = await client.query(
      `SELECT id, topic FROM outbox_events WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [t.id]
    );
    const future = rows.rows.find((r) => r.topic === "durability.future");
    const past = rows.rows.find((r) => r.topic === "durability.past");
    futureId = future.id;
    pastId = past.id;
    // Push the "future" row's next_attempt_at ahead; leave the "past" row at its default (now()).
    await client.query(`UPDATE outbox_events SET next_attempt_at = now() + INTERVAL '1 hour' WHERE id = $1`, [
      futureId
    ]);
    await client.query(`UPDATE outbox_events SET next_attempt_at = now() - INTERVAL '1 minute' WHERE id = $1`, [
      pastId
    ]);
  });

  const claimed = await outboxRepository.claim(100);
  const claimedIds = claimed.map((r) => r.id);
  assert.ok(claimedIds.includes(pastId), "row with past next_attempt_at should be claimed");
  assert.ok(!claimedIds.includes(futureId), "row with future next_attempt_at should NOT be claimed");

  // Clean up: mark the claimed row processed so it doesn't linger as 'processing'.
  await outboxRepository.markProcessed(pastId);
});

// Characterisation test, not a red-green cycle: outbox_claim already respected
// its limit before migration 022 on every plan reachable today, and the bad plan
// could not be forced. It pins the contract so the MATERIALIZED CTE cannot be
// dropped, and so an over-claim is caught if a future index or statistics change
// makes the semi-join plan reachable. Over-claiming would mark rows 'processing'
// that the tick never publishes, stalling them until the 2-minute stuck-row rule.
test("outbox_claim never returns more rows than its limit", { skip }, async () => {
  const t = await tenantRepository.create("Outbox Limit Tenant");
  await withTenant(t.id, async (client) => {
    for (let i = 0; i < 12; i++) {
      await outboxRepository.enqueue(client, t.id, { topic: "durability.limit", payload: { i } });
    }
  });

  const claimed = await outboxRepository.claim(4);
  assert.ok(claimed.length <= 4, `claim(4) must never return more than 4 rows, got ${claimed.length}`);

  // Leave nothing stuck in 'processing' for the other tests in this file.
  for (const row of claimed) {
    await outboxRepository.markProcessed(row.id);
  }
});

test("markFailed walks a row to 'dead' after max attempts and backs off next_attempt_at", { skip }, async () => {
  const t = await tenantRepository.create("Outbox Durability Tenant B");
  let id;
  await withTenant(t.id, async (client) => {
    await outboxRepository.enqueue(client, t.id, {
      topic: "durability.poison",
      payload: { poison: true }
    });
    const rows = await client.query(`SELECT id FROM outbox_events WHERE tenant_id = $1`, [t.id]);
    id = rows.rows[0].id;
  });

  // First failure: still under the default max (8) -> stays pending, backs off into the future.
  const before = Date.now();
  await outboxRepository.markFailed(id, "boom: handler threw");
  const afterFirst = await withTenant(t.id, async (client) => {
    const r = await client.query(
      `SELECT status, attempts, last_error, next_attempt_at FROM outbox_events WHERE id = $1`,
      [id]
    );
    return r.rows[0];
  });
  assert.equal(afterFirst.status, "pending");
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.last_error, "boom: handler threw");
  assert.ok(
    new Date(afterFirst.next_attempt_at).getTime() > before,
    "next_attempt_at should be pushed into the future after a failure"
  );

  // Fail 7 more times (8 total) to walk the row into 'dead'.
  for (let i = 0; i < 7; i++) {
    await outboxRepository.markFailed(id, `boom attempt ${i + 2}`);
  }

  const final = await withTenant(t.id, async (client) => {
    const r = await client.query(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [id]);
    return r.rows[0];
  });
  assert.equal(final.status, "dead");
  assert.equal(final.attempts, 8);
});

test("replayDead resets a dead row to pending, is idempotent, and is tenant-isolated", { skip }, async () => {
  const owner = await tenantRepository.create("Outbox Durability Owner");
  const other = await tenantRepository.create("Outbox Durability Other");
  let id;
  await withTenant(owner.id, async (client) => {
    await outboxRepository.enqueue(client, owner.id, {
      topic: "durability.replay",
      payload: { replay: true }
    });
    const rows = await client.query(`SELECT id FROM outbox_events WHERE tenant_id = $1`, [owner.id]);
    id = rows.rows[0].id;
    // Force the row straight to 'dead' without walking through 8 markFailed calls.
    await client.query(`UPDATE outbox_events SET status = 'dead', attempts = 8, last_error = 'seed' WHERE id = $1`, [
      id
    ]);
  });

  // A different tenant cannot see or replay the row (RLS).
  const otherList = await outboxRepository.listDead(other.id, 50);
  assert.equal(
    otherList.some((r) => r.id === id),
    false,
    "another tenant must not see the dead row"
  );
  const otherReplay = await outboxRepository.replayDead(other.id, id);
  assert.equal(otherReplay, false, "another tenant must not be able to replay the row");

  const ownerList = await outboxRepository.listDead(owner.id, 50);
  const found = ownerList.find((r) => r.id === id);
  assert.ok(found, "owning tenant should see the dead row");
  assert.equal(found.topic, "durability.replay");
  assert.equal(found.attempts, 8);

  const replayed = await outboxRepository.replayDead(owner.id, id);
  assert.equal(replayed, true, "first replay should succeed");

  const afterReplay = await withTenant(owner.id, async (client) => {
    const r = await client.query(`SELECT status, attempts, last_error FROM outbox_events WHERE id = $1`, [id]);
    return r.rows[0];
  });
  assert.equal(afterReplay.status, "pending");
  assert.equal(afterReplay.attempts, 0);
  assert.equal(afterReplay.last_error, null);

  // Second replay is a no-op: the row is no longer 'dead'.
  const replayedAgain = await outboxRepository.replayDead(owner.id, id);
  assert.equal(replayedAgain, false, "second replay should return false");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
