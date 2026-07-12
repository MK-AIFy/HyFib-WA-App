import test from "node:test";
import assert from "node:assert/strict";
import { resolveOrgTenant, PLATFORM_TENANT_ID } from "../dist/single-org.js";

const tenant = (overrides = {}) => ({
  id: PLATFORM_TENANT_ID,
  name: "HyFib Platform",
  status: "active",
  plan: "enterprise",
  maxUsers: 9999,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

function makeDeps(overrides = {}) {
  const logs = [];
  return {
    listTenants: async () => [],
    getTenantById: async () => undefined,
    updateTenant: async () => {
      throw new Error("updateTenant should not be called in this scenario");
    },
    env: {},
    log: (msg, meta) => logs.push({ msg, meta }),
    ...overrides,
    __logs: logs
  };
}

test("env-pinned id found returns that tenant without calling listTenants", async () => {
  const pinned = tenant({ id: "11111111-1111-1111-1111-111111111111", name: "Pinned Org" });
  let listCalled = false;
  const deps = makeDeps({
    env: { orgTenantId: pinned.id },
    getTenantById: async (id) => {
      assert.equal(id, pinned.id);
      return pinned;
    },
    listTenants: async () => {
      listCalled = true;
      return [];
    }
  });

  const result = await resolveOrgTenant(deps);

  assert.deepEqual(result, pinned);
  assert.equal(listCalled, false);
});

test("env-pinned id missing throws mentioning ORG_TENANT_ID", async () => {
  const deps = makeDeps({
    env: { orgTenantId: "22222222-2222-2222-2222-222222222222" },
    getTenantById: async () => undefined
  });

  await assert.rejects(
    () => resolveOrgTenant(deps),
    (err) => {
      assert.match(err.message, /ORG_TENANT_ID/);
      assert.match(err.message, /22222222-2222-2222-2222-222222222222/);
      return true;
    }
  );
});

test("no env pin, exactly one active tenant returns it", async () => {
  const active = tenant({ id: "active-1" });
  const deps = makeDeps({
    listTenants: async () => [active, tenant({ id: "suspended-1", status: "suspended" })]
  });

  const result = await resolveOrgTenant(deps);

  assert.deepEqual(result, active);
});

test("no env pin, zero tenants throws", async () => {
  const deps = makeDeps({ listTenants: async () => [] });

  await assert.rejects(() => resolveOrgTenant(deps), /expected exactly one tenant, found 0/);
});

test("no env pin, multiple tenants throws mentioning ORG_TENANT_ID", async () => {
  const deps = makeDeps({
    listTenants: async () => [tenant({ id: "a" }), tenant({ id: "b" })]
  });

  await assert.rejects(
    () => resolveOrgTenant(deps),
    (err) => {
      assert.match(err.message, /expected exactly one tenant, found 2/);
      assert.match(err.message, /ORG_TENANT_ID/);
      return true;
    }
  );
});

test("orgName set and different calls updateTenant once and returns renamed tenant", async () => {
  const original = tenant({ id: "org-1", name: "Old Name" });
  const renamed = tenant({ id: "org-1", name: "New Name" });
  let updateCalls = 0;
  const deps = makeDeps({
    env: { orgTenantId: original.id, orgName: "New Name" },
    getTenantById: async () => original,
    updateTenant: async (id, patch) => {
      updateCalls += 1;
      assert.equal(id, original.id);
      assert.deepEqual(patch, { name: "New Name" });
      return renamed;
    }
  });

  const result = await resolveOrgTenant(deps);

  assert.equal(updateCalls, 1);
  assert.equal(result.name, "New Name");
});

test("orgName equal to current name does not call updateTenant", async () => {
  const original = tenant({ id: "org-1", name: "Same Name" });
  const deps = makeDeps({
    env: { orgTenantId: original.id, orgName: "Same Name" },
    getTenantById: async () => original
  });

  const result = await resolveOrgTenant(deps);

  assert.deepEqual(result, original);
});
