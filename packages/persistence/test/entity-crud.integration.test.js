import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  autoReplyRuleRepository,
  automationRuleRepository,
  segmentRepository,
  teamRepository,
  channelRepository,
  contactRepository,
  userRepository,
  campaignRepository,
  templateRepository,
  orderRepository,
  closePool
} from "../dist/index.js";

// Entity CRUD completion (roadmap A4/A5): update/delete methods that the
// gateway's edit/delete routes depend on. Requires a live PostgreSQL with all
// migrations applied; CI provides it, locally run with RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("auto-reply rule: update fields then delete", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD AutoReply Tenant");
  const rule = await autoReplyRuleRepository.create(tenant.id, {
    matchType: "keyword",
    keyword: "hi",
    replyText: "Hello!",
    priority: 1
  });

  const updated = await autoReplyRuleRepository.update(tenant.id, rule.id, {
    matchType: "contains",
    keyword: "help",
    replyText: "How can we help?",
    priority: 5,
    enabled: false
  });
  assert.equal(updated?.matchType, "contains");
  assert.equal(updated?.keyword, "help");
  assert.equal(updated?.replyText, "How can we help?");
  assert.equal(updated?.priority, 5);
  assert.equal(updated?.enabled, false);

  const partial = await autoReplyRuleRepository.update(tenant.id, rule.id, { priority: 9 });
  assert.equal(partial?.keyword, "help", "untouched fields survive a partial update");
  assert.equal(partial?.priority, 9);

  assert.equal(await autoReplyRuleRepository.delete(tenant.id, rule.id), true);
  assert.equal(await autoReplyRuleRepository.delete(tenant.id, rule.id), false);
});

test("automation rule: update fields then delete", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD Automation Tenant");
  const rule = await automationRuleRepository.create(tenant.id, {
    name: "Tag hot leads",
    triggerType: "new_message",
    conditions: { keyword: "buy" },
    actionType: "add_tag",
    actionConfig: { tag: "hot" }
  });

  const updated = await automationRuleRepository.update(tenant.id, rule.id, {
    name: "Tag warm leads",
    conditions: { keyword: "info" },
    actionConfig: { tag: "warm" },
    priority: 3,
    enabled: false
  });
  assert.equal(updated?.name, "Tag warm leads");
  assert.deepEqual(updated?.conditions, { keyword: "info" });
  assert.deepEqual(updated?.actionConfig, { tag: "warm" });
  assert.equal(updated?.priority, 3);
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.triggerType, "new_message", "untouched trigger survives");

  assert.equal(await automationRuleRepository.delete(tenant.id, rule.id), true);
  assert.equal(await automationRuleRepository.delete(tenant.id, rule.id), false);
});

test("segment: update name/definition, delete, and FK block when a campaign references it", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD Segment Tenant");
  const segment = await segmentRepository.create(tenant.id, { name: "All", definition: {} });

  const updated = await segmentRepository.update(tenant.id, segment.id, {
    name: "India buyers",
    definition: { country: "IN" }
  });
  assert.equal(updated?.name, "India buyers");
  assert.deepEqual(updated?.definition, { country: "IN" });

  const nameOnly = await segmentRepository.update(tenant.id, segment.id, { name: "Renamed" });
  assert.deepEqual(nameOnly?.definition, { country: "IN" }, "definition survives a name-only update");

  const inUse = await segmentRepository.create(tenant.id, { name: "In use", definition: {} });
  const template = await templateRepository.create(tenant.id, {
    name: `seg_fk_${Date.now()}`,
    category: "marketing",
    language: "en",
    body: "x"
  });
  await campaignRepository.create(tenant.id, { name: "Seg FK", templateId: template.id, segmentId: inUse.id });
  await assert.rejects(
    () => segmentRepository.delete(tenant.id, inUse.id),
    (error) => error?.code === "23503"
  );

  assert.equal(await segmentRepository.delete(tenant.id, segment.id), true);
  assert.equal(await segmentRepository.delete(tenant.id, segment.id), false);
});

test("team: delete cascades members and returns false on a second delete", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD Team Tenant");
  const team = await teamRepository.create(tenant.id, { name: "Support" });
  const user = await userRepository.create(tenant.id, {
    email: `team-crud-${Date.now()}@example.com`,
    displayName: "Member",
    roles: ["support_agent"]
  });
  await teamRepository.addMember(tenant.id, team.id, user.id);

  assert.equal(await teamRepository.delete(tenant.id, team.id), true);
  assert.equal(await teamRepository.getById(tenant.id, team.id), undefined);
  assert.equal(await teamRepository.delete(tenant.id, team.id), false);
});

test(
  "channel: update display number, active flag, and rotate token (cache must not serve stale creds)",
  { skip },
  async () => {
    const tenant = await tenantRepository.create("CRUD Channel Tenant");
    const channel = await channelRepository.create(tenant.id, {
      wabaId: `waba-${Date.now()}`,
      phoneNumberId: `pn-${Date.now()}`,
      displayPhoneNumber: "+15550009999"
    });

    // Prime the credentials cache, then rotate — the update must invalidate it.
    await channelRepository.getCredentials(tenant.id, channel.id);
    const updated = await channelRepository.update(tenant.id, channel.id, {
      displayPhoneNumber: "+15550008888",
      isActive: false,
      accessToken: "rotated-token"
    });
    assert.equal(updated?.displayPhoneNumber, "+15550008888");
    assert.equal(updated?.status, "inactive");
    assert.equal(updated?.hasAccessToken, true);

    const creds = await channelRepository.getCredentials(tenant.id, channel.id);
    assert.equal(creds?.accessToken, "rotated-token", "rotated token visible immediately (no stale cache)");
  }
);

test("contact: update names/timezone/country then delete; FK block when history exists", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD Contact Tenant");
  const contact = await contactRepository.create(tenant.id, {
    phoneE164: "+15550101010",
    firstName: "Asha",
    country: "IN",
    tags: ["vip"]
  });

  const updated = await contactRepository.update(tenant.id, contact.id, {
    firstName: "Asha",
    lastName: "Rao",
    timezone: "Asia/Kolkata",
    country: "AE"
  });
  assert.equal(updated?.lastName, "Rao");
  assert.equal(updated?.timezone, "Asia/Kolkata");
  assert.equal(updated?.country, "AE");
  assert.deepEqual(updated?.tags, ["vip"], "tags survive a profile update");

  const blocked = await contactRepository.create(tenant.id, { phoneE164: "+15550102020" });
  await orderRepository.create(tenant.id, {
    contactId: blocked.id,
    externalOrderId: `ord-${Date.now()}`,
    amountMinor: 500,
    currency: "INR"
  });
  await assert.rejects(
    () => contactRepository.delete(tenant.id, blocked.id),
    (error) => error?.code === "23503"
  );

  assert.equal(await contactRepository.delete(tenant.id, contact.id), true);
  assert.equal(await contactRepository.delete(tenant.id, contact.id), false);
});

test("user: updateRoles syncs both role_bindings and the users.roles column", { skip }, async () => {
  const tenant = await tenantRepository.create("CRUD Roles Tenant");
  const user = await userRepository.create(tenant.id, {
    email: `roles-crud-${Date.now()}@example.com`,
    displayName: "Role Target",
    roles: ["sales_agent", "support_agent"]
  });

  const updated = await userRepository.updateRoles(tenant.id, user.id, ["analyst"]);
  assert.deepEqual([...(updated?.roles ?? [])].sort(), ["analyst"], "USER_SELECT (role_bindings) reflects the change");

  const again = await userRepository.getById(tenant.id, user.id);
  assert.deepEqual([...(again?.roles ?? [])].sort(), ["analyst"]);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
