import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInbound, normalizeStatus } from "../dist/normalize.js";

const value = (over = {}) => ({
  metadata: { phone_number_id: "PNID" },
  contacts: [{ wa_id: "15551230000", profile: { name: "Alice" } }],
  ...over
});

test("normalizes a text message with profile name", () => {
  const event = normalizeInbound(
    value(),
    { id: "wamid.1", from: "15551230000", type: "text", timestamp: "1700000000", text: { body: "hello" } },
    "WABA"
  );
  assert.equal(event.phoneNumberId, "PNID");
  assert.equal(event.profileName, "Alice");
  assert.equal(event.text, "hello");
  assert.equal(event.entryId, "WABA");
});

test("normalizes an image message with media and caption", () => {
  const event = normalizeInbound(value(), {
    id: "wamid.2",
    from: "15551230000",
    type: "image",
    image: { id: "MID", mime_type: "image/jpeg", sha256: "abc", caption: "a pic" }
  });
  assert.deepEqual(event.media, {
    id: "MID",
    mimeType: "image/jpeg",
    sha256: "abc",
    caption: "a pic",
    filename: undefined
  });
  assert.equal(event.text, "a pic");
});

test("normalizes an interactive button reply (text derived for opt-out checks)", () => {
  const event = normalizeInbound(value(), {
    id: "wamid.3",
    from: "15551230000",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "STOP", title: "Stop" } }
  });
  assert.deepEqual(event.interactive, { kind: "button_reply", id: "STOP", title: "Stop" });
  assert.equal(event.text, "Stop");
});

test("normalizes a list reply", () => {
  const event = normalizeInbound(value(), {
    id: "wamid.4",
    from: "15551230000",
    type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "opt-2", title: "Option 2", description: "second" } }
  });
  assert.equal(event.interactive.kind, "list_reply");
  assert.equal(event.interactive.description, "second");
});

test("normalizes location, reaction, button and referral", () => {
  const loc = normalizeInbound(value(), {
    id: "1",
    type: "location",
    location: { latitude: 1.5, longitude: -2.5, name: "HQ", address: "1 St" }
  });
  assert.deepEqual(loc.location, { latitude: 1.5, longitude: -2.5, name: "HQ", address: "1 St" });
  assert.equal(loc.text, "HQ");

  const react = normalizeInbound(value(), {
    id: "2",
    type: "reaction",
    reaction: { emoji: "👍", message_id: "wamid.x" }
  });
  assert.deepEqual(react.reaction, { emoji: "👍", messageId: "wamid.x" });

  const btn = normalizeInbound(value(), { id: "3", type: "button", button: { payload: "STOP", text: "Unsubscribe" } });
  assert.deepEqual(btn.button, { payload: "STOP", text: "Unsubscribe" });
  assert.equal(btn.text, "Unsubscribe");

  const ref = normalizeInbound(value(), {
    id: "4",
    type: "text",
    text: { body: "hi" },
    referral: { source_url: "https://ad" }
  });
  assert.deepEqual(ref.referral, { source_url: "https://ad" });
});

test("normalizes context (forwarded + referred message)", () => {
  const event = normalizeInbound(value(), {
    id: "5",
    type: "text",
    text: { body: "re" },
    context: { forwarded: true, id: "wamid.orig" }
  });
  assert.deepEqual(event.context, { forwarded: true, referredMessageId: "wamid.orig" });
});

test("normalizes a status with pricing, conversation and errors", () => {
  const event = normalizeStatus(value(), {
    id: "wamid.9",
    status: "delivered",
    recipient_id: "15551230000",
    timestamp: "1700000001",
    pricing: { billable: true, pricing_model: "CBP", category: "marketing" },
    conversation: { id: "conv-1", origin: { type: "marketing" }, expiration_timestamp: "1700100000" },
    errors: [{ code: 131000, title: "err", error_data: { details: "boom" } }]
  });
  assert.equal(event.status, "delivered");
  assert.deepEqual(event.pricing, { billable: true, category: "marketing", model: "CBP" });
  assert.deepEqual(event.conversation, { id: "conv-1", originType: "marketing", expiresAt: "1700100000" });
  assert.equal(event.errors[0].message, "boom");
});
