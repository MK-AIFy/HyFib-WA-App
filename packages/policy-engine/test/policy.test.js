import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOutboundPolicy, isInsideQuietHours } from "../dist/index.js";

const approvedMarketing = {
  id: "t1",
  tenantId: "tenant-1",
  name: "promo",
  category: "marketing",
  status: "approved",
  language: "en",
  body: "Hello {{1}}"
};

function baseContext(overrides = {}) {
  return {
    hasActiveConsent: true,
    isInside24hWindow: false,
    template: approvedMarketing,
    requestedCategory: "marketing",
    isOptedOut: false,
    currentHourLocal: 12,
    ...overrides
  };
}

test("allows a compliant business-initiated marketing message", () => {
  assert.deepEqual(evaluateOutboundPolicy(baseContext()), { allowed: true });
});

test("blocks when the contact is opted out", () => {
  const result = evaluateOutboundPolicy(baseContext({ isOptedOut: true }));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /opted out/i);
});

test("blocks when there is no active consent", () => {
  const result = evaluateOutboundPolicy(baseContext({ hasActiveConsent: false }));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /consent/i);
});

test("blocks an unapproved template outside the 24h window", () => {
  const result = evaluateOutboundPolicy(baseContext({ template: { ...approvedMarketing, status: "pending" } }));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not approved/i);
});

test("blocks on template category mismatch", () => {
  const result = evaluateOutboundPolicy(baseContext({ requestedCategory: "utility" }));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /category mismatch/i);
});

test("blocks during quiet hours", () => {
  const result = evaluateOutboundPolicy(
    baseContext({ currentHourLocal: 23, quietHours: { startHour: 22, endHour: 7 } })
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /quiet hours/i);
});

test("blocks when the frequency cap is reached", () => {
  const result = evaluateOutboundPolicy(
    baseContext({ frequencyCap: { maxMessages: 3, periodHours: 24, sentInPeriod: 3 } })
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /frequency cap/i);
});

test("blocks for routing-blocked countries", () => {
  const result = evaluateOutboundPolicy(baseContext({ countryBlocked: true }));
  assert.equal(result.allowed, false);
});

test("isInsideQuietHours handles overnight windows", () => {
  assert.equal(isInsideQuietHours(23, { startHour: 22, endHour: 7 }), true);
  assert.equal(isInsideQuietHours(3, { startHour: 22, endHour: 7 }), true);
  assert.equal(isInsideQuietHours(12, { startHour: 22, endHour: 7 }), false);
});
