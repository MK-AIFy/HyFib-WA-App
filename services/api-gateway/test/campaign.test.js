import test from "node:test";
import assert from "node:assert/strict";
import {
  filterSendableContacts,
  CAMPAIGN_TRANSITIONS,
  canTransition,
  transitionConflict
} from "../dist/campaign.js";

const contact = (id, optedOut) => ({ id, phoneE164: "+1555000000" + id, optedOut });

test("filterSendableContacts removes opted-out contacts and counts suppressed", () => {
  const { eligible, suppressed } = filterSendableContacts([
    contact("1", false),
    contact("2", true),
    contact("3", false),
    contact("4", true)
  ]);
  assert.deepEqual(
    eligible.map((c) => c.id),
    ["1", "3"]
  );
  assert.equal(suppressed, 2);
});

test("filterSendableContacts keeps all when none opted out", () => {
  const { eligible, suppressed } = filterSendableContacts([contact("1", false), contact("2", false)]);
  assert.equal(eligible.length, 2);
  assert.equal(suppressed, 0);
});

test("filterSendableContacts handles an empty audience", () => {
  const { eligible, suppressed } = filterSendableContacts([]);
  assert.equal(eligible.length, 0);
  assert.equal(suppressed, 0);
});

test("canTransition: pause is legal from running and scheduled only", () => {
  assert.equal(canTransition("running", "pause"), true);
  assert.equal(canTransition("scheduled", "pause"), true);
  for (const status of ["draft", "paused", "completed"]) {
    assert.equal(canTransition(status, "pause"), false, `pause from ${status} must be illegal`);
  }
});

test("canTransition: resume is legal from paused only", () => {
  assert.equal(canTransition("paused", "resume"), true);
  for (const status of ["draft", "scheduled", "running", "completed"]) {
    assert.equal(canTransition(status, "resume"), false, `resume from ${status} must be illegal`);
  }
});

test("canTransition: an unknown status is never transitionable", () => {
  // repositories.ts casts the DB value with an unchecked `as`, so an out-of-union
  // string can reach here. Returning false is the desired behaviour.
  assert.equal(canTransition("banana", "pause"), false);
  assert.equal(canTransition("banana", "resume"), false);
});

test("CAMPAIGN_TRANSITIONS declares the target status for each action", () => {
  assert.equal(CAMPAIGN_TRANSITIONS.pause.to, "paused");
  assert.equal(CAMPAIGN_TRANSITIONS.resume.to, "running");
});

test("transitionConflict names the current status so the operator can act on it", () => {
  assert.match(transitionConflict("completed", "pause"), /completed/);
  assert.match(transitionConflict("running", "resume"), /running/);
});
