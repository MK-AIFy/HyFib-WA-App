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
    await client.query(`UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1 AND contact_id = $2`, [
      campaign.id,
      contacts[0].id
    ]);
    await client.query(
      `UPDATE campaign_recipients SET status = 'policy_skipped' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[1].id]
    );
  });

  const batch = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 10);

  assert.equal(batch.length, 1, "only the single remaining pending row should be claimed");
  assert.equal(batch[0].contactId, contacts[2].id);
});

test("claimPendingBatch reclaims a stale claim but leaves a fresh one alone", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Stale", 2);

  const claimed = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.equal(claimed.length, 2);

  // Nothing is stale yet, so a second claim finds nothing.
  const immediate = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.deepEqual(immediate, [], "a claim inside the stale window must not be reclaimed");

  // Backdate exactly one row's claim past the window.
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaign_recipients SET claimed_at = now() - INTERVAL '30 minutes' WHERE id = $1`, [
      claimed[0].id
    ]);
  });

  const reclaimed = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 2, 15);
  assert.equal(reclaimed.length, 1, "only the backdated row should be reclaimed");
  assert.equal(reclaimed[0].id, claimed[0].id);
});

test("claimPendingBatch is tenant-isolated through the claim UPDATE", { skip }, async () => {
  const owner = await seedCampaign("OwnerIso", 3);
  const other = await seedCampaign("OtherIso", 3);

  // Claiming as the other tenant must not reach the owner's campaign: the RLS
  // policy on campaign_recipients scopes the UPDATE, not just the CTE.
  const crossTenant = await campaignRecipientRepository.claimPendingBatch(other.tenant.id, owner.campaign.id, 10);
  assert.deepEqual(crossTenant, [], "a tenant must not claim another tenant's recipients");

  // The owner's rows are therefore still unclaimed and fully available.
  const ownClaim = await campaignRecipientRepository.claimPendingBatch(owner.tenant.id, owner.campaign.id, 10);
  assert.equal(ownClaim.length, 3);
});

async function readStatus(tenantId, recipientId) {
  return withTenant(tenantId, async (client) => {
    const r = await client.query(`SELECT status, skip_reason FROM campaign_recipients WHERE id = $1`, [recipientId]);
    return r.rows[0];
  });
}

test("updateStatus with onlyIfStatus will not clobber an already-advanced row", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("Guard", 1);
  const [recipient] = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 1);

  // Simulate the send having already landed and a delivery receipt arriving.
  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, { status: "sent" });
  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, { status: "delivered" });

  // A late duplicate-suppression write guarded on 'pending' must be a no-op.
  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, {
    status: "policy_skipped",
    skipReason: "duplicate_send_suppressed",
    onlyIfStatus: "pending"
  });

  const after = await readStatus(tenant.id, recipient.id);
  assert.equal(after.status, "delivered", "a guarded write must not downgrade a delivered recipient");
  assert.equal(after.skip_reason, null, "a no-op write must not leave a skip_reason behind");
});

test("updateStatus with onlyIfStatus applies when the row still matches", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("GuardApplies", 1);
  const [recipient] = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 1);

  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, {
    status: "policy_skipped",
    skipReason: "duplicate_send_suppressed",
    onlyIfStatus: "pending"
  });

  const after = await readStatus(tenant.id, recipient.id);
  assert.equal(after.status, "policy_skipped");
  assert.equal(after.skip_reason, "duplicate_send_suppressed");
});

test("updateStatus without onlyIfStatus keeps its existing unguarded behaviour", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("GuardOmitted", 1);
  const [recipient] = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 1);

  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, { status: "sent" });
  // No guard passed: the write applies regardless of current status, as before.
  await campaignRecipientRepository.updateStatus(tenant.id, recipient.id, { status: "failed", error: "boom" });

  const after = await readStatus(tenant.id, recipient.id);
  assert.equal(after.status, "failed");
});

async function readCampaignStatus(tenantId, campaignId) {
  return withTenant(tenantId, async (client) => {
    const r = await client.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    return r.rows[0]?.status;
  });
}

test("transition applies from a legal status and reports that it applied", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionOk", 1);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [campaign.id]);
  });

  const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running", "scheduled"], "paused");

  assert.equal(applied, true);
  assert.equal(await readCampaignStatus(tenant.id, campaign.id), "paused");
});

test("transition is a no-op from an illegal status and returns false", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionIllegal", 1);
  // seedCampaign leaves the campaign in 'draft', not a legal source for pause.

  const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running", "scheduled"], "paused");

  assert.equal(applied, false, "an illegal transition must report false, not throw");
  assert.equal(await readCampaignStatus(tenant.id, campaign.id), "draft", "status must be untouched");
});

test("transition cannot cross tenants", { skip }, async () => {
  const owner = await seedCampaign("TransitionOwner", 1);
  const other = await seedCampaign("TransitionOther", 1);
  await withTenant(owner.tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [owner.campaign.id]);
  });

  const applied = await campaignRepository.transition(other.tenant.id, owner.campaign.id, ["running"], "paused");

  assert.equal(applied, false, "another tenant must not be able to transition this campaign");
  assert.equal(await readCampaignStatus(owner.tenant.id, owner.campaign.id), "running");
});

test("transition joins a caller's transaction and rolls back with it", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("TransitionTxn", 1);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [campaign.id]);
  });

  // Resume must flip status and enqueue its run event atomically. Prove the flip
  // is genuinely inside the caller's transaction by aborting that transaction.
  await assert.rejects(
    withTenant(tenant.id, async (client) => {
      const applied = await campaignRepository.transition(tenant.id, campaign.id, ["running"], "paused", client);
      assert.equal(applied, true);
      throw new Error("abort");
    }),
    /abort/
  );

  assert.equal(
    await readCampaignStatus(tenant.id, campaign.id),
    "running",
    "a rolled-back transaction must leave the status unchanged"
  );
});

test("getStatus reads the current status without a join", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("GetStatus", 1);

  assert.equal(await campaignRepository.getStatus(tenant.id, campaign.id), "draft");

  await campaignRepository.transition(tenant.id, campaign.id, ["draft"], "running");
  assert.equal(await campaignRepository.getStatus(tenant.id, campaign.id), "running");
});

test("getStatus returns undefined for an unknown or other-tenant campaign", { skip }, async () => {
  const owner = await seedCampaign("GetStatusOwner", 1);
  const other = await seedCampaign("GetStatusOther", 1);

  assert.equal(
    await campaignRepository.getStatus(other.tenant.id, owner.campaign.id),
    undefined,
    "RLS must hide another tenant's campaign rather than leaking its status"
  );
  assert.equal(await campaignRepository.getStatus(owner.tenant.id, "00000000-0000-0000-0000-0000000000ff"), undefined);
});

test("cancelPending retires only the still-pending recipients and reports how many", { skip }, async () => {
  const { tenant, campaign, contacts } = await seedCampaign("CancelPending", 4);

  // One already sent, one already delivered — both must survive untouched, or
  // cancelling would rewrite the record of messages that really went out.
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1 AND contact_id = $2`, [
      campaign.id,
      contacts[0].id
    ]);
    await client.query(
      `UPDATE campaign_recipients SET status = 'delivered' WHERE campaign_id = $1 AND contact_id = $2`,
      [campaign.id, contacts[1].id]
    );
  });

  const retired = await campaignRecipientRepository.cancelPending(tenant.id, campaign.id);
  assert.equal(retired, 2, "only the two pending recipients should be retired");

  const counts = await campaignRecipientRepository.funnelCounts(tenant.id, campaign.id);
  assert.equal(counts.pending ?? 0, 0, "the funnel must drain to zero pending");
  assert.equal(counts.sent, 1, "an already-sent recipient must be left alone");
  assert.equal(counts.delivered, 1, "an already-delivered recipient must be left alone");
  assert.equal(counts.policy_skipped, 2);
});

test("cancelPending records why the recipients were retired", { skip }, async () => {
  const { tenant, campaign } = await seedCampaign("CancelReason", 2);

  await campaignRecipientRepository.cancelPending(tenant.id, campaign.id);

  const reasons = await withTenant(tenant.id, async (client) => {
    const r = await client.query(
      `SELECT DISTINCT skip_reason FROM campaign_recipients WHERE campaign_id = $1 AND status = 'policy_skipped'`,
      [campaign.id]
    );
    return r.rows.map((row) => row.skip_reason);
  });
  assert.deepEqual(reasons, ["campaign_cancelled"]);
});

test("cancelPending is idempotent and tenant-isolated", { skip }, async () => {
  const owner = await seedCampaign("CancelOwner", 2);
  const other = await seedCampaign("CancelOther", 2);

  assert.equal(await campaignRecipientRepository.cancelPending(owner.tenant.id, owner.campaign.id), 2);
  assert.equal(
    await campaignRecipientRepository.cancelPending(owner.tenant.id, owner.campaign.id),
    0,
    "a second cancel must retire nothing"
  );
  assert.equal(
    await campaignRecipientRepository.cancelPending(other.tenant.id, owner.campaign.id),
    0,
    "another tenant must not be able to retire these recipients"
  );

  const otherCounts = await campaignRecipientRepository.funnelCounts(other.tenant.id, other.campaign.id);
  assert.equal(otherCounts.pending, 2, "the other tenant's own campaign must be untouched");
});

/** Puts a seeded campaign into 'running' and returns it. */
async function runningCampaign(label, recipientCount) {
  const seeded = await seedCampaign(label, recipientCount);
  await campaignRepository.transition(seeded.tenant.id, seeded.campaign.id, ["draft"], "running");
  return seeded;
}

test("completeDrained completes a running campaign whose recipients have all resolved", { skip }, async () => {
  const { tenant, campaign } = await runningCampaign("Drained", 2);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1`, [campaign.id]);
  });

  const completed = await campaignRepository.completeDrained(50);

  assert.ok(
    completed.some((c) => c.id === campaign.id && c.tenantId === tenant.id),
    "a drained campaign should be completed and reported with its tenant"
  );
  assert.equal(await campaignRepository.getStatus(tenant.id, campaign.id), "completed");
});

test("completeDrained leaves a campaign with a pending recipient alone", { skip }, async () => {
  // This is the whole point: a claimed-but-undispatched recipient is still
  // 'pending', so an in-flight run must never be completed out from under itself.
  const { tenant, campaign } = await runningCampaign("StillPending", 2);
  await withTenant(tenant.id, async (client) => {
    await client.query(
      `UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1
       AND id = (SELECT id FROM campaign_recipients WHERE campaign_id = $1 LIMIT 1)`,
      [campaign.id]
    );
  });
  // Claim the remaining one, exactly as a live fan-out would.
  const claimed = await campaignRecipientRepository.claimPendingBatch(tenant.id, campaign.id, 10);
  assert.equal(claimed.length, 1, "one recipient should still be claimable");

  await campaignRepository.completeDrained(50);

  assert.equal(
    await campaignRepository.getStatus(tenant.id, campaign.id),
    "running",
    "a claimed-but-undispatched recipient must keep the campaign running"
  );
});

test("completeDrained ignores a running campaign that has no recipients at all", { skip }, async () => {
  // A single-number test send promotes a draft campaign to 'running' without
  // creating recipients; completing it immediately would be wrong.
  const { tenant, campaign } = await runningCampaign("NoRecipients", 0);

  await campaignRepository.completeDrained(50);

  assert.equal(await campaignRepository.getStatus(tenant.id, campaign.id), "running");
});

test("completeDrained never completes a paused campaign", { skip }, async () => {
  const { tenant, campaign } = await runningCampaign("PausedDrained", 1);
  await withTenant(tenant.id, async (client) => {
    await client.query(`UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1`, [campaign.id]);
  });
  await campaignRepository.transition(tenant.id, campaign.id, ["running"], "paused");

  await campaignRepository.completeDrained(50);

  assert.equal(
    await campaignRepository.getStatus(tenant.id, campaign.id),
    "paused",
    "an operator pause must win over the completion sweep"
  );
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
