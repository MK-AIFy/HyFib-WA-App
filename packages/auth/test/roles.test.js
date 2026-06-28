import test from "node:test";
import assert from "node:assert/strict";
import { hasAnyRole, normalizeRoles } from "../dist/index.js";

test("hasAnyRole returns true when a required role is present", () => {
  const ctx = { subject: "s", roles: ["marketing_manager", "analyst"] };
  assert.equal(hasAnyRole(ctx, ["platform_owner", "marketing_manager"]), true);
});

test("hasAnyRole returns false when no required role is present", () => {
  const ctx = { subject: "s", roles: ["analyst"] };
  assert.equal(hasAnyRole(ctx, ["platform_owner", "tenant_admin"]), false);
});

test("hasAnyRole returns false for an empty role set", () => {
  const ctx = { subject: "s", roles: [] };
  assert.equal(hasAnyRole(ctx, ["analyst"]), false);
});

test("normalizeRoles expands CRM owner bundle", () => {
  const roles = normalizeRoles(["owner"]);
  assert.equal(roles.includes("platform_owner"), true);
  assert.equal(roles.includes("tenant_admin"), true);
  assert.equal(roles.includes("marketing_manager"), true);
});

test("normalizeRoles supports mixed aliases and direct roles without duplicates", () => {
  const roles = normalizeRoles(["agent", "sales_agent", "viewer"]);
  assert.equal(roles.includes("sales_agent"), true);
  assert.equal(roles.includes("support_agent"), true);
  assert.equal(roles.includes("analyst"), true);
  assert.equal(new Set(roles).size, roles.length);
});
