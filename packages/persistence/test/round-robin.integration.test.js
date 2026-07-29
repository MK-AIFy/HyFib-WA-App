import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  teamRepository,
  userRepository,
  automationSettingsRepository,
  closePool
} from "../dist/index.js";

// Round-robin auto-assignment (roadmap G9). Requires migration 027.
const skip = !process.env.RUN_DB_TESTS;

async function setup() {
  const tenant = await tenantRepository.create("RoundRobin Tenant");
  const team = await teamRepository.create(tenant.id, { name: "Rotation" });
  const users = [];
  for (const name of ["a", "b", "c"]) {
    const user = await userRepository.create(tenant.id, {
      email: `rr-${name}-${Date.now()}@example.com`,
      displayName: `Agent ${name.toUpperCase()}`,
      roles: ["support_agent"]
    });
    await teamRepository.addMember(tenant.id, team.id, user.id);
    users.push(user);
  }
  return { tenant, team, users };
}

test("rotation walks the team in stable order and wraps around", { skip }, async () => {
  const { tenant, team, users } = await setup();
  await automationSettingsRepository.upsert(tenant.id, { roundRobinEnabled: true, roundRobinTeamId: team.id });

  const picks = [];
  for (let i = 0; i < 4; i += 1) {
    const pick = await teamRepository.nextRoundRobinAssignee(tenant.id, team.id);
    assert.ok(pick, `pick ${i} must resolve`);
    picks.push(pick.id);
  }
  // 3 members: the 4th pick wraps back to the 1st member picked.
  assert.equal(new Set(picks.slice(0, 3)).size, 3, "first cycle covers all members");
  assert.equal(picks[3], picks[0], "4th pick wraps to the first member");
  assert.equal(
    users.some((u) => u.id === picks[0]),
    true
  );
});

test("suspended members are skipped", { skip }, async () => {
  const { tenant, team, users } = await setup();
  await automationSettingsRepository.upsert(tenant.id, { roundRobinEnabled: true, roundRobinTeamId: team.id });
  await userRepository.updateStatus(tenant.id, users[1].id, "suspended");

  const picks = new Set();
  for (let i = 0; i < 4; i += 1) {
    const pick = await teamRepository.nextRoundRobinAssignee(tenant.id, team.id);
    assert.ok(pick);
    picks.add(pick.id);
  }
  assert.equal(picks.has(users[1].id), false, "suspended member never picked");
  assert.equal(picks.size, 2);
});

test("an empty or memberless team yields no assignee", { skip }, async () => {
  const tenant = await tenantRepository.create("RoundRobin Empty Tenant");
  const team = await teamRepository.create(tenant.id, { name: "Empty" });
  assert.equal(await teamRepository.nextRoundRobinAssignee(tenant.id, team.id), undefined);
});

test("settings round-trip the round-robin fields", { skip }, async () => {
  const { tenant, team } = await setup();
  const saved = await automationSettingsRepository.upsert(tenant.id, {
    roundRobinEnabled: true,
    roundRobinTeamId: team.id
  });
  assert.equal(saved.roundRobinEnabled, true);
  assert.equal(saved.roundRobinTeamId, team.id);

  const cleared = await automationSettingsRepository.upsert(tenant.id, { roundRobinTeamId: null });
  assert.equal(cleared.roundRobinTeamId, undefined);
  assert.equal(cleared.roundRobinEnabled, true, "enabled flag untouched by team clear");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
