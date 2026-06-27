import test from "node:test";
import assert from "node:assert/strict";
import { canCreateContact, canCreateOrder } from "../dist/authorization.js";

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
