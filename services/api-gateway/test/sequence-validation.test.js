import test from "node:test";
import assert from "node:assert/strict";
import { validateSequenceCreate, MAX_SEQUENCE_STEPS } from "../dist/sequence-validation.js";

const CH = "11111111-1111-1111-1111-111111111111";
const TPL = "22222222-2222-2222-2222-222222222222";

test("a valid sequence passes with stopOnReply defaulting to true", () => {
  const result = validateSequenceCreate({
    name: "  Onboarding  ",
    channelId: CH,
    steps: [
      { delayMinutes: 0, templateId: TPL },
      { delayMinutes: 1440, templateId: TPL }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "Onboarding");
  assert.equal(result.value.stopOnReply, true);
  assert.equal(result.value.steps.length, 2);
});

test("steps are bounded and typed", () => {
  assert.equal(validateSequenceCreate({ name: "x", channelId: CH, steps: [] }).ok, false);
  assert.equal(
    validateSequenceCreate({
      name: "x",
      channelId: CH,
      steps: Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => ({ delayMinutes: 1, templateId: TPL }))
    }).ok,
    false
  );
  assert.equal(
    validateSequenceCreate({ name: "x", channelId: CH, steps: [{ delayMinutes: -1, templateId: TPL }] }).ok,
    false
  );
  assert.equal(
    validateSequenceCreate({ name: "x", channelId: CH, steps: [{ delayMinutes: 1.5, templateId: TPL }] }).ok,
    false
  );
  assert.equal(
    validateSequenceCreate({ name: "x", channelId: CH, steps: [{ delayMinutes: 1, templateId: "nope" }] }).ok,
    false
  );
});

test("name/channel/stopOnReply shape checks", () => {
  assert.equal(validateSequenceCreate({ channelId: CH, steps: [{ delayMinutes: 1, templateId: TPL }] }).ok, false);
  assert.equal(
    validateSequenceCreate({ name: "x", channelId: "bad", steps: [{ delayMinutes: 1, templateId: TPL }] }).ok,
    false
  );
  assert.equal(
    validateSequenceCreate({
      name: "x",
      channelId: CH,
      stopOnReply: "yes",
      steps: [{ delayMinutes: 1, templateId: TPL }]
    }).ok,
    false
  );
});
