import test from "node:test";
import assert from "node:assert/strict";
import { filterSendableContacts } from "../dist/campaign.js";

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
