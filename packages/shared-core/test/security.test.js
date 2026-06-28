import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyMetaSignature, verifyWebhookToken, redactPII } from "../dist/index.js";

const secret = "app-secret";
const body = JSON.stringify({ entry: [{ id: "waba-1" }] });

function sign(rawBody, key = secret) {
  return `sha256=${createHmac("sha256", key).update(rawBody).digest("hex")}`;
}

test("accepts a correctly signed payload", () => {
  assert.equal(verifyMetaSignature(body, sign(body), secret), true);
});

test("rejects a tampered payload", () => {
  assert.equal(verifyMetaSignature(`${body} `, sign(body), secret), false);
});

test("rejects a signature made with the wrong secret", () => {
  assert.equal(verifyMetaSignature(body, sign(body, "wrong"), secret), false);
});

test("rejects a missing or malformed signature header", () => {
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
  assert.equal(verifyMetaSignature(body, "deadbeef", secret), false);
});

test("verifyWebhookToken accepts a matching token and rejects mismatches", () => {
  assert.equal(verifyWebhookToken("verify-123", "verify-123"), true);
  assert.equal(verifyWebhookToken("verify-123", "verify-124"), false);
  assert.equal(verifyWebhookToken("short", "longer-token"), false);
  assert.equal(verifyWebhookToken(null, "verify-123"), false);
  assert.equal(verifyWebhookToken("", ""), false);
});

test("redactPII masks phone numbers and emails", () => {
  const redacted = redactPII("call +14155552671 or mail jane.doe@example.com");
  assert.match(redacted, /\[REDACTED_PHONE\]/);
  assert.match(redacted, /\[REDACTED_EMAIL\]/);
  assert.doesNotMatch(redacted, /4155552671/);
});
