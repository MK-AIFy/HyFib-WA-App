import test from "node:test";
import assert from "node:assert/strict";
import { hasAnyRole } from "../dist/index.js";

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
