import test from "node:test";
import assert from "node:assert/strict";
import { buildOutboundAdapterCall } from "../dist/outbound.js";

const channel = { phoneNumberId: "PN-1", accessToken: "tok-1" };
const base = {
  tenantId: "t-1",
  channelId: "c-1",
  conversationId: "conv-1",
  contactPhoneE164: "+15551230000",
  actorId: "actor-1"
};

test("text command maps to send-text with channel credentials", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "text", text: "hello", previewUrl: true }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-text");
  assert.deepEqual(call.payload, {
    phoneNumberId: "PN-1",
    to: "+15551230000",
    text: "hello",
    previewUrl: true,
    accessToken: "tok-1"
  });
  assert.deepEqual(call.persistedPayload, { kind: "text", text: "hello", actorId: "actor-1" });
});

test("media command maps to send-media", () => {
  const media = { mediaType: "image", mediaId: "MID", caption: "pic" };
  const call = buildOutboundAdapterCall({ ...base, kind: "media", media }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-media");
  assert.equal(call.payload.mediaType, "image");
  assert.equal(call.payload.mediaId, "MID");
  assert.equal(call.payload.accessToken, "tok-1");
  assert.deepEqual(call.persistedPayload, { kind: "media", media, actorId: "actor-1" });
});

test("interactive command maps to send-interactive with the full payload", () => {
  const interactive = {
    interactiveType: "button",
    bodyText: "Pick one",
    buttons: [{ id: "yes", title: "Yes" }]
  };
  const call = buildOutboundAdapterCall({ ...base, kind: "interactive", interactive }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-interactive");
  assert.equal(call.payload.phoneNumberId, "PN-1");
  assert.equal(call.payload.to, "+15551230000");
  assert.equal(call.payload.interactiveType, "button");
  assert.equal(call.payload.bodyText, "Pick one");
  assert.deepEqual(call.payload.buttons, [{ id: "yes", title: "Yes" }]);
  assert.equal(call.payload.accessToken, "tok-1");
  assert.deepEqual(call.persistedPayload, { kind: "interactive", interactive, actorId: "actor-1" });
});

test("interactive kind without a payload falls back to text", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "interactive", text: "fallback" }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-text");
});

test("channel without a token omits accessToken from persistence but keeps undefined in payload", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "text", text: "x" }, { phoneNumberId: "PN-2" });
  assert.equal(call.payload.accessToken, undefined);
  assert.equal(call.payload.phoneNumberId, "PN-2");
});
