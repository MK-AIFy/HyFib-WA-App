import test from "node:test";
import assert from "node:assert/strict";
import { isOptOutKeyword, isOptInKeyword } from "../dist/index.js";

test("detects opt-out keywords (case/punctuation insensitive)", () => {
  for (const text of ["STOP", "stop", "Stop.", "please UNSUBSCRIBE", "cancel", "opt-out"]) {
    assert.equal(isOptOutKeyword(text), true, `expected opt-out for: ${text}`);
  }
});

test("does not treat ordinary replies as opt-out", () => {
  for (const text of ["hello", "I want to buy", "tell me more", ""]) {
    assert.equal(isOptOutKeyword(text), false, `unexpected opt-out for: ${text}`);
  }
});

test("detects opt-in keywords", () => {
  for (const text of ["START", "subscribe", "unstop"]) {
    assert.equal(isOptInKeyword(text), true, `expected opt-in for: ${text}`);
  }
});

test("handles undefined input", () => {
  assert.equal(isOptOutKeyword(undefined), false);
  assert.equal(isOptInKeyword(undefined), false);
});

// An opt-out revokes consent and blocks every later outbound message to the contact, so a false positive silently
// cuts a real customer off ("can you cancel my order?" is never answered) while a false negative leaves a STOP
// unhonoured. Words are therefore trusted only as far as they are unambiguous.
function expectEach(matcher, texts, expected) {
  for (const text of texts) {
    assert.equal(matcher(text), expected, `${matcher.name}(${JSON.stringify(text)}) should be ${expected}`);
  }
}

test("opts out on the standard STOP forms however they are dressed up", () => {
  expectEach(
    isOptOutKeyword,
    [
      "  stop  ",
      "\nSTOP\t",
      "Stop!!!",
      "stop, please",
      "🛑 STOP",
      "STOP STOP STOP",
      "stop all",
      "STOPALL",
      "please stop",
      "pls stop",
      "stop now",
      "stop messaging me",
      "stop texting me",
      "please stop sending me messages",
      "stop sending me these messages",
      "I want to stop receiving messages",
      "can you please stop messaging me",
      "I want you to stop sending me whatsapp messages",
      "I'd like you to stop messaging me",
      "I’d like you to stop messaging me",
      "plz u need to stop sending msgs thx"
    ],
    true
  );
});

test("opts out when a stop request is padded with conversational words", () => {
  expectEach(
    isOptOutKeyword,
    [
      "stop it",
      "STOP IT ALREADY",
      "I said stop",
      "I already told you to stop",
      "ok stop",
      "okay stop",
      "Hi, please stop messaging me",
      "Hello sir, please stop sending me messages",
      "Madam please stop",
      "mam stop",
      "hey stop messaging me again",
      "stop messaging me anymore",
      "Kindly stop sending messages to this number"
    ],
    true
  );
});

test("opts out on an unambiguous unsubscribe word anywhere in the message", () => {
  expectEach(
    isOptOutKeyword,
    [
      "I want to unsubscribe",
      "how do I unsubscribe from this?",
      "please unsubscribe me",
      "opt out",
      "I'd like to opt out",
      "Opt-Out",
      "optout"
    ],
    true
  );
});

test("opts out on cancel, end and quit only when that is the whole message", () => {
  expectEach(isOptOutKeyword, ["cancel", "CANCEL!", "end", "Quit."], true);
});

test("opts out on quick-reply button titles and payloads", () => {
  // The webhook normaliser feeds button and interactive replies (title, else payload) through the same matcher.
  expectEach(
    isOptOutKeyword,
    ["Stop promotions", "Stop marketing messages", "Unsubscribe", "STOP_PROMOTIONS", "STOP_ALL", "OPT_OUT"],
    true
  );
});

test("does not opt out when an everyday word merely appears in a sentence", () => {
  expectEach(
    isOptOutKeyword,
    [
      "Can you cancel my order?",
      "cancel 12345",
      "when does the sale end",
      "please dont end my subscription",
      "Can you stop by tomorrow?",
      "I want to stop by your store",
      "please stop all deliveries until Monday",
      "don't stop sending updates",
      "the bus stop is near my house"
    ],
    false
  );
});

test("does not opt out on a caption or shared-location name that contains an opt-out word", () => {
  // The webhook normaliser also returns media captions and location names, which reach the matcher as "text".
  expectEach(isOptOutKeyword, ["Bus Stop 12", "End of Line Cafe", "Quit Smoking Clinic"], false);
});

test("opts in only on an exact opt-in keyword", () => {
  expectEach(
    isOptInKeyword,
    ["START", "Start.", "  start  ", "subscribe", "unstop", "opt-in", "opt in", "OPTIN"],
    true
  );
});

test("does not re-consent on a sentence that merely contains an opt-in word", () => {
  expectEach(
    isOptInKeyword,
    [
      "yes please deliver tomorrow",
      "when does it start",
      "let's start",
      "I want to start a return",
      "how do I subscribe"
    ],
    false
  );
});

test("a bare yes is not an opt-in", () => {
  // "yes" answers any question ("Is this your address?"), so treating it as consent would silently re-subscribe an
  // opted-out customer. Consent has to come from an explicit keyword such as START.
  expectEach(isOptInKeyword, ["yes", "YES", "Yes!", "yes please"], false);
});

test("opt-out and opt-in keywords do not overlap", () => {
  expectEach(isOptInKeyword, ["STOP", "unsubscribe", "cancel", "opt-out"], false);
  expectEach(isOptOutKeyword, ["START", "subscribe", "unstop", "opt-in"], false);
});

test("treats blank and symbol-only input as no keyword", () => {
  for (const matcher of [isOptOutKeyword, isOptInKeyword]) {
    expectEach(matcher, ["   ", "...", "!!!", "🛑"], false);
  }
});
