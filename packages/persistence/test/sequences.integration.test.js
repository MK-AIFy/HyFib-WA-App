import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  templateRepository,
  channelRepository,
  contactRepository,
  sequenceRepository,
  outboxRepository,
  withTenant,
  query,
  closePool
} from "../dist/index.js";

// Drip sequences (roadmap G7). Requires migration 029. RUN_DB_TESTS=1 locally.
const skip = !process.env.RUN_DB_TESTS;

async function fixture() {
  const tenant = await tenantRepository.create("Sequence Tenant");
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-seq-${Date.now()}`,
    phoneNumberId: `pn-seq-${Date.now()}`,
    displayPhoneNumber: "+15558880001"
  });
  const tpl1 = await templateRepository.create(tenant.id, {
    name: `seq_t1_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "step one"
  });
  const tpl2 = await templateRepository.create(tenant.id, {
    name: `seq_t2_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "step two"
  });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15558880002" });
  return { tenant, channel, tpl1, tpl2, contact };
}

/** Forces an enrollment due NOW (tests can't wait out real delays). */
async function makeDue(tenantId, sequenceId, contactId) {
  await withTenant(tenantId, (client) =>
    client.query(
      "UPDATE sequence_enrollments SET next_step_at = now() - interval '1 minute' WHERE sequence_id = $1 AND contact_id = $2",
      [sequenceId, contactId]
    )
  );
}

test("sequence lifecycle: create → enroll → advance both steps → complete, outbox rows enqueued", { skip }, async () => {
  const { tenant, channel, tpl1, tpl2, contact } = await fixture();
  const sequence = await sequenceRepository.create(tenant.id, {
    name: "Onboarding drip",
    channelId: channel.id,
    steps: [
      { delayMinutes: 0, templateId: tpl1.id },
      { delayMinutes: 60, templateId: tpl2.id }
    ]
  });
  await sequenceRepository.setStatus(tenant.id, sequence.id, "active");

  assert.equal(await sequenceRepository.enroll(tenant.id, sequence.id, [contact.id]), 1);
  assert.equal(await sequenceRepository.enroll(tenant.id, sequence.id, [contact.id]), 0, "re-enroll is a no-op");

  const due = await query("SELECT * FROM due_sequence_enrollments($1)", [10]);
  const mine = due.rows.find((r) => r.tenant_id === tenant.id);
  assert.ok(mine, "enrollment with delay 0 is due immediately");

  const first = await sequenceRepository.advanceDueEnrollment(tenant.id, mine.id);
  assert.equal(first.action, "send");
  assert.equal(first.stepOrder, 1);
  assert.equal(first.templateName, tpl1.name);
  assert.equal(first.completedAfterSend, false);

  // Not due again until step 2's delay elapses.
  assert.deepEqual(await sequenceRepository.advanceDueEnrollment(tenant.id, mine.id), { action: "skipped" });

  await makeDue(tenant.id, sequence.id, contact.id);
  const second = await sequenceRepository.advanceDueEnrollment(tenant.id, mine.id);
  assert.equal(second.action, "send");
  assert.equal(second.stepOrder, 2);
  assert.equal(second.templateName, tpl2.name);
  assert.equal(second.completedAfterSend, true);

  const detail = await sequenceRepository.getById(tenant.id, sequence.id);
  assert.equal(detail.steps.length, 2);
  const listed = await sequenceRepository.list(tenant.id);
  assert.deepEqual(listed[0].enrollmentCounts, { active: 0, completed: 1, stopped: 0 });

  // Both steps rode the durable outbox as automation-template sends.
  const outbox = await withTenant(tenant.id, (client) =>
    client.query("SELECT payload FROM outbox_events WHERE topic = 'automation.template.requested'")
  );
  const forContact = outbox.rows.filter((r) => r.payload.contactPhoneE164 === "+15558880002");
  assert.equal(forContact.length, 2);
});

test("stop-on-reply stops active enrollments; opted-out contacts stop at advance", { skip }, async () => {
  const { tenant, channel, tpl1, contact } = await fixture();
  const sequence = await sequenceRepository.create(tenant.id, {
    name: "Reply-stop drip",
    channelId: channel.id,
    steps: [{ delayMinutes: 0, templateId: tpl1.id }]
  });
  await sequenceRepository.setStatus(tenant.id, sequence.id, "active");
  await sequenceRepository.enroll(tenant.id, sequence.id, [contact.id]);

  assert.equal(await sequenceRepository.stopActiveForContact(tenant.id, contact.id, "replied"), 1);
  assert.equal(await sequenceRepository.stopActiveForContact(tenant.id, contact.id, "replied"), 0, "already stopped");

  // A paused sequence's due enrollments are skipped, not consumed.
  const other = await contactRepository.create(tenant.id, { phoneE164: "+15558880003" });
  await sequenceRepository.enroll(tenant.id, sequence.id, [other.id]);
  await sequenceRepository.setStatus(tenant.id, sequence.id, "paused");
  const enrollment = await withTenant(tenant.id, (client) =>
    client.query("SELECT id FROM sequence_enrollments WHERE contact_id = $1", [other.id])
  );
  assert.deepEqual(await sequenceRepository.advanceDueEnrollment(tenant.id, enrollment.rows[0].id), {
    action: "skipped"
  });

  // Opt-out mid-sequence stops at the next advance.
  await sequenceRepository.setStatus(tenant.id, sequence.id, "active");
  await contactRepository.setOptedOut(tenant.id, other.id, true);
  const stopped = await sequenceRepository.advanceDueEnrollment(tenant.id, enrollment.rows[0].id);
  assert.deepEqual(stopped, { action: "stopped", reason: "opted_out" });
});

test("enroll excludes already-opted-out contacts and requires a first step", { skip }, async () => {
  const { tenant, channel, tpl1 } = await fixture();
  const optedOut = await contactRepository.create(tenant.id, { phoneE164: "+15558880004" });
  await contactRepository.setOptedOut(tenant.id, optedOut.id, true);

  const sequence = await sequenceRepository.create(tenant.id, {
    name: "Consent drip",
    channelId: channel.id,
    steps: [{ delayMinutes: 5, templateId: tpl1.id }]
  });
  assert.equal(await sequenceRepository.enroll(tenant.id, sequence.id, [optedOut.id]), 0);

  const empty = await sequenceRepository.create(tenant.id, {
    name: "No steps",
    channelId: channel.id,
    steps: []
  });
  assert.equal(await sequenceRepository.enroll(tenant.id, empty.id, [optedOut.id]), 0);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
