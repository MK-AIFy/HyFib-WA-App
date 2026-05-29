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
  for (const text of ["START", "subscribe", "YES", "unstop"]) {
    assert.equal(isOptInKeyword(text), true, `expected opt-in for: ${text}`);
  }
});

test("handles undefined input", () => {
  assert.equal(isOptOutKeyword(undefined), false);
  assert.equal(isOptInKeyword(undefined), false);
});
