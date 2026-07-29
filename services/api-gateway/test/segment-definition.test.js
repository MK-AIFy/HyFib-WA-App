import test from "node:test";
import assert from "node:assert/strict";
import { validateSegmentDefinition } from "../dist/segment-definition.js";

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";

test("undefined and empty definitions pass", () => {
  assert.deepEqual(validateSegmentDefinition(undefined), { ok: true, value: {} });
  assert.deepEqual(validateSegmentDefinition({}), { ok: true, value: {} });
});

test("classic filters validate types and bounds", () => {
  const ok = validateSegmentDefinition({ tags: ["vip"], country: "IN", hasConsent: true });
  assert.equal(ok.ok, true);
  assert.equal(validateSegmentDefinition({ tags: [42] }).ok, false);
  assert.equal(validateSegmentDefinition({ country: "" }).ok, false);
  assert.equal(validateSegmentDefinition({ hasConsent: "yes" }).ok, false);
  assert.equal(validateSegmentDefinition({ surprise: 1 }).ok, false);
});

test("retargeting clause: id required, statuses from the funnel enum, clicked boolean", () => {
  const full = validateSegmentDefinition({
    campaign: { id: CAMPAIGN_ID, statuses: ["delivered", "failed"], clicked: false }
  });
  assert.equal(full.ok, true);
  assert.deepEqual(full.value.campaign, { id: CAMPAIGN_ID, statuses: ["delivered", "failed"], clicked: false });

  assert.equal(validateSegmentDefinition({ campaign: { id: "nope" } }).ok, false);
  assert.equal(validateSegmentDefinition({ campaign: { id: CAMPAIGN_ID, statuses: [] } }).ok, false);
  assert.equal(validateSegmentDefinition({ campaign: { id: CAMPAIGN_ID, statuses: ["bounced"] } }).ok, false);
  assert.equal(validateSegmentDefinition({ campaign: { id: CAMPAIGN_ID, clicked: "yes" } }).ok, false);
  assert.equal(validateSegmentDefinition({ campaign: { id: CAMPAIGN_ID, extra: 1 } }).ok, false);
});
