import test from "node:test";
import assert from "node:assert/strict";
import { tenantRepository, userRepository, sessionRepository, closePool } from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role + auth
// migrations (013_auth.sql, 014_auth_rls_bypass.sql) applied — run
// `pnpm migrate` against the target database first.
// CI provides it via service containers; locally run with RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("findByEmailForAuth resolves a user across tenants and updatePassword changes the hash", { skip }, async () => {
  const tenant = await tenantRepository.create("Auth Test Tenant");
  const email = `auth-test-${Date.now()}@example.com`;
  const user = await userRepository.create(tenant.id, {
    email,
    displayName: "Auth Test User",
    roles: ["tenant_admin"],
    passwordHash: "salt1:hash1"
  });

  const found = await userRepository.findByEmailForAuth(email);
  assert.ok(found, "expected findByEmailForAuth to locate the user without tenant context");
  assert.equal(found.id, user.id);
  assert.equal(found.tenantId, tenant.id);
  assert.equal(found.passwordHash, "salt1:hash1");
  assert.deepEqual([...found.roles].sort(), ["tenant_admin"]);

  await userRepository.updatePassword(tenant.id, user.id, "salt2:hash2");
  const updated = await userRepository.findByEmailForAuth(email);
  assert.equal(updated?.passwordHash, "salt2:hash2");

  const missing = await userRepository.findByEmailForAuth(`nobody-${Date.now()}@example.com`);
  assert.equal(missing, undefined);
});

test("sessions round-trip through create/findByToken/deleteByToken and reject expired tokens", { skip }, async () => {
  const tenant = await tenantRepository.create("Session Test Tenant");
  const user = await userRepository.create(tenant.id, {
    email: `session-test-${Date.now()}@example.com`,
    displayName: "Session Test User",
    roles: ["tenant_admin"]
  });

  const live = await sessionRepository.create({
    userId: user.id,
    tenantId: tenant.id,
    tokenHash: `live-${Date.now()}`,
    ttlSeconds: 3600
  });
  const found = await sessionRepository.findByToken(live.tokenHash);
  assert.ok(found, "expected to find the freshly created session");
  assert.equal(found.userId, user.id);
  assert.equal(found.tenantId, tenant.id);

  await sessionRepository.deleteByToken(live.tokenHash);
  assert.equal(await sessionRepository.findByToken(live.tokenHash), undefined);

  const expired = await sessionRepository.create({
    userId: user.id,
    tenantId: tenant.id,
    tokenHash: `expired-${Date.now()}`,
    ttlSeconds: -60
  });
  assert.equal(await sessionRepository.findByToken(expired.tokenHash), undefined, "expired sessions must not resolve");
});

test("deleteAllForUser revokes every session for that user", { skip }, async () => {
  const tenant = await tenantRepository.create("Revoke Test Tenant");
  const user = await userRepository.create(tenant.id, {
    email: `revoke-test-${Date.now()}@example.com`,
    displayName: "Revoke Test User",
    roles: ["tenant_admin"]
  });

  const a = await sessionRepository.create({
    userId: user.id,
    tenantId: tenant.id,
    tokenHash: `a-${Date.now()}`,
    ttlSeconds: 3600
  });
  const b = await sessionRepository.create({
    userId: user.id,
    tenantId: tenant.id,
    tokenHash: `b-${Date.now()}`,
    ttlSeconds: 3600
  });

  await sessionRepository.deleteAllForUser(user.id);

  assert.equal(await sessionRepository.findByToken(a.tokenHash), undefined);
  assert.equal(await sessionRepository.findByToken(b.tokenHash), undefined);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
