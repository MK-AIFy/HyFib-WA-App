import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeHumanCaller,
  authorizeIdentityAdmin,
  authorizePasswordSet,
  authorizeRoleGrant,
  authorizeUserUpdate,
  canCreateContact,
  canCreateOrder,
  isApiKeyCaller
} from "../dist/authorization.js";

const authWith = (...roles) => ({ subject: "user-1", tenantId: "tenant-1", roles });

test("read-only roles cannot create contacts or orders", () => {
  for (const role of ["analyst", "compliance_auditor"]) {
    assert.equal(canCreateContact(authWith(role)), false, `${role} must not create contacts`);
    assert.equal(canCreateOrder(authWith(role)), false, `${role} must not create orders`);
  }
});

test("writer roles can create contacts and orders", () => {
  for (const role of ["platform_owner", "tenant_admin", "marketing_manager"]) {
    assert.equal(canCreateContact(authWith(role)), true, `${role} must create contacts`);
    assert.equal(canCreateOrder(authWith(role)), true, `${role} must create orders`);
  }
});

test("support_agent can record orders but not create contacts", () => {
  assert.equal(canCreateOrder(authWith("support_agent")), true);
  assert.equal(canCreateContact(authWith("support_agent")), false);
});

test("a principal with no roles is denied", () => {
  assert.equal(canCreateContact(authWith()), false);
  assert.equal(canCreateOrder(authWith()), false);
});

test("any single allowed role among many grants access", () => {
  assert.equal(canCreateContact(authWith("analyst", "marketing_manager")), true);
  assert.equal(canCreateOrder(authWith("compliance_auditor", "support_agent")), true);
});

// ─── User and credential management ───────────────────────────────────────────

const SELF_ID = "11111111-1111-4111-8111-111111111111";
const session = (...roles) => ({ subject: SELF_ID, tenantId: "tenant-1", roles });
// resolveAuth gives an API-key caller the subject `apikey:<key id>`; nothing else marks it.
const apiKey = (...roles) => ({ subject: "apikey:22222222-2222-4222-8222-222222222222", tenantId: "tenant-1", roles });

const ownerUser = { id: "33333333-3333-4333-8333-333333333333", roles: ["platform_owner"] };
const agentUser = { id: "44444444-4444-4444-8444-444444444444", roles: ["support_agent"] };
const adminUser = { id: "55555555-5555-4555-8555-555555555555", roles: ["tenant_admin", "marketing_manager"] };

const NON_OWNER_ROLES = [
  "tenant_admin",
  "marketing_manager",
  "sales_agent",
  "support_agent",
  "analyst",
  "compliance_auditor"
];

function assertDenied(decision, error, message) {
  assert.equal(decision.ok, false, message);
  assert.equal(decision.error, error, message);
}

test("isApiKeyCaller recognises only the apikey: subject resolveAuth assigns", () => {
  assert.equal(isApiKeyCaller(apiKey("tenant_admin")), true);
  assert.equal(isApiKeyCaller(session("tenant_admin")), false);
  assert.equal(isApiKeyCaller({ subject: "dev-subject", roles: ["tenant_admin"] }), false);
});

test("identity admin gate: session admins pass, other roles and every API key are refused", () => {
  assert.deepEqual(authorizeIdentityAdmin(session("platform_owner")), { ok: true });
  assert.deepEqual(authorizeIdentityAdmin(session("tenant_admin")), { ok: true });
  for (const role of ["marketing_manager", "support_agent", "analyst"]) {
    assertDenied(authorizeIdentityAdmin(session(role)), "Insufficient role", `${role} is not a user admin`);
  }
  assertDenied(authorizeIdentityAdmin(session()), "Insufficient role");
  assertDenied(authorizeIdentityAdmin(apiKey("tenant_admin")), "api_key_forbidden");
  // A key can never be created with platform_owner, but one that carries it anyway is still a key.
  assertDenied(authorizeIdentityAdmin(apiKey("platform_owner")), "api_key_forbidden");
  assert.match(authorizeIdentityAdmin(apiKey("tenant_admin")).detail, /API keys/);
});

test("a session platform_owner can grant every role, platform_owner included", () => {
  assert.deepEqual(authorizeRoleGrant(session("platform_owner"), ["platform_owner"]), { ok: true });
  assert.deepEqual(authorizeRoleGrant(session("platform_owner"), ["tenant_admin", "marketing_manager"]), { ok: true });
});

test("a session tenant_admin can grant every non-owner role, including ones it does not hold", () => {
  for (const role of NON_OWNER_ROLES) {
    assert.deepEqual(authorizeRoleGrant(session("tenant_admin"), [role]), { ok: true }, `tenant_admin grants ${role}`);
  }
  assert.deepEqual(authorizeRoleGrant(session("tenant_admin"), NON_OWNER_ROLES), { ok: true });
});

test("a tenant_admin cannot grant platform_owner, alone, mixed in, or smuggled in as the owner bundle", () => {
  const alone = authorizeRoleGrant(session("tenant_admin"), ["platform_owner"]);
  assertDenied(alone, "role_not_grantable");
  assert.match(alone.detail, /platform_owner/);
  assertDenied(authorizeRoleGrant(session("tenant_admin"), ["support_agent", "platform_owner"]), "role_not_grantable");
  assertDenied(authorizeRoleGrant(session("tenant_admin"), ["owner"]), "role_not_grantable");
  assertDenied(authorizeRoleGrant(session("tenant_admin"), [" Platform_Owner "]), "role_not_grantable");
});

test("an unknown role is never grantable, so a missed validation step fails closed", () => {
  assertDenied(authorizeRoleGrant(session("platform_owner"), ["superuser"]), "role_not_grantable");
});

test("an API key cannot create a user with any role (the user comes back with a tempPassword)", () => {
  assertDenied(authorizeRoleGrant(apiKey("tenant_admin"), ["support_agent"]), "api_key_forbidden");
  assertDenied(authorizeRoleGrant(apiKey("tenant_admin"), ["platform_owner"]), "api_key_forbidden");
  assertDenied(authorizeRoleGrant(apiKey("platform_owner"), ["platform_owner"]), "api_key_forbidden");
});

test("non-admins cannot grant roles", () => {
  assertDenied(authorizeRoleGrant(session("marketing_manager"), ["analyst"]), "Insufficient role");
});

test("a session tenant_admin can suspend and re-role agents and peer admins", () => {
  assert.deepEqual(authorizeUserUpdate(session("tenant_admin"), agentUser, undefined), { ok: true });
  assert.deepEqual(authorizeUserUpdate(session("tenant_admin"), agentUser, ["tenant_admin"]), { ok: true });
  assert.deepEqual(authorizeUserUpdate(session("tenant_admin"), adminUser, ["analyst"]), { ok: true });
});

test("a tenant_admin cannot promote anyone to platform_owner by PATCH", () => {
  assertDenied(authorizeUserUpdate(session("tenant_admin"), agentUser, ["platform_owner"]), "role_not_grantable");
  assertDenied(
    authorizeUserUpdate(session("tenant_admin"), agentUser, ["support_agent", "platform_owner"]),
    "role_not_grantable"
  );
});

test("a tenant_admin cannot suspend, demote or otherwise modify a platform_owner", () => {
  const suspend = authorizeUserUpdate(session("tenant_admin"), ownerUser, undefined);
  assertDenied(suspend, "user_not_manageable");
  assert.match(suspend.detail, /platform_owner/);
  assertDenied(authorizeUserUpdate(session("tenant_admin"), ownerUser, ["analyst"]), "user_not_manageable");
  // A user bound to the legacy CRM "owner" bundle resolves to platform_owner at login, so it is protected too.
  assertDenied(
    authorizeUserUpdate(session("tenant_admin"), { id: ownerUser.id, roles: ["owner"] }, undefined),
    "user_not_manageable"
  );
});

test("a session platform_owner can promote to and demote from platform_owner", () => {
  assert.deepEqual(authorizeUserUpdate(session("platform_owner"), agentUser, ["platform_owner"]), { ok: true });
  assert.deepEqual(authorizeUserUpdate(session("platform_owner"), ownerUser, ["tenant_admin"]), { ok: true });
  assert.deepEqual(authorizeUserUpdate(session("platform_owner"), ownerUser, undefined), { ok: true });
});

test("an unknown stored role does not lock a user away from its admins", () => {
  const legacyAgent = { id: agentUser.id, roles: ["support_agent", "legacy_role"] };
  assert.deepEqual(authorizeUserUpdate(session("tenant_admin"), legacyAgent, undefined), { ok: true });
});

test("an API key cannot change any user's status or roles", () => {
  assertDenied(authorizeUserUpdate(apiKey("tenant_admin"), agentUser, undefined), "api_key_forbidden");
  assertDenied(authorizeUserUpdate(apiKey("tenant_admin"), agentUser, ["tenant_admin"]), "api_key_forbidden");
  assertDenied(authorizeUserUpdate(apiKey("tenant_admin"), ownerUser, ["analyst"]), "api_key_forbidden");
});

test("non-admins cannot PATCH users", () => {
  assertDenied(authorizeUserUpdate(session("support_agent"), agentUser, undefined), "Insufficient role");
});

test("anyone signed in may set their own password", () => {
  for (const role of ["analyst", "support_agent", "tenant_admin", "platform_owner"]) {
    assert.deepEqual(authorizePasswordSet(session(role), { id: SELF_ID, roles: [role] }), { ok: true }, role);
  }
});

test("a session tenant_admin may reset a non-owner's password but not a platform_owner's", () => {
  assert.deepEqual(authorizePasswordSet(session("tenant_admin"), agentUser), { ok: true });
  assert.deepEqual(authorizePasswordSet(session("tenant_admin"), adminUser), { ok: true });
  assertDenied(authorizePasswordSet(session("tenant_admin"), ownerUser), "user_not_manageable");
});

test("a session platform_owner may reset any password", () => {
  assert.deepEqual(authorizePasswordSet(session("platform_owner"), ownerUser), { ok: true });
  assert.deepEqual(authorizePasswordSet(session("platform_owner"), agentUser), { ok: true });
});

test("an API key can never set a password", () => {
  assertDenied(authorizePasswordSet(apiKey("tenant_admin"), agentUser), "api_key_forbidden");
  assertDenied(authorizePasswordSet(apiKey("tenant_admin"), ownerUser), "api_key_forbidden");
});

test("the API-key gate a route runs before any lookup refuses every key and passes every other caller", () => {
  assertDenied(authorizeHumanCaller(apiKey("tenant_admin")), "api_key_forbidden");
  assertDenied(authorizeHumanCaller(apiKey("platform_owner")), "api_key_forbidden");
  assertDenied(authorizeHumanCaller(apiKey()), "api_key_forbidden");
  for (const role of ["analyst", "support_agent", "tenant_admin", "platform_owner"]) {
    assert.deepEqual(authorizeHumanCaller(session(role)), { ok: true }, role);
  }
  // set-password runs this gate before looking the target up; the refusal must match the full decision's.
  assert.deepEqual(
    authorizeHumanCaller(apiKey("tenant_admin")),
    authorizePasswordSet(apiKey("tenant_admin"), agentUser)
  );
});

test("a non-admin cannot set someone else's password", () => {
  assertDenied(authorizePasswordSet(session("analyst"), agentUser), "Can only change your own password");
});
