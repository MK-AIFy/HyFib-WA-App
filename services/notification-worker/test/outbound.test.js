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

test("interactive cta_url command maps to send-interactive with ctaDisplayText/ctaUrl", () => {
  const interactive = {
    interactiveType: "cta_url",
    bodyText: "Check us out",
    ctaDisplayText: "Visit",
    ctaUrl: "https://example.com"
  };
  const call = buildOutboundAdapterCall({ ...base, kind: "interactive", interactive }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-interactive");
  assert.equal(call.payload.interactiveType, "cta_url");
  assert.equal(call.payload.ctaDisplayText, "Visit");
  assert.equal(call.payload.ctaUrl, "https://example.com");
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

test("template command maps to send-template with parameters defaulted to an empty array", () => {
  const template = { templateName: "order_confirmation", templateLanguage: "en_US" };
  const call = buildOutboundAdapterCall({ ...base, kind: "template", template }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-template");
  assert.equal(call.payload.phoneNumberId, "PN-1");
  assert.equal(call.payload.to, "+15551230000");
  assert.equal(call.payload.templateName, "order_confirmation");
  assert.equal(call.payload.templateLanguage, "en_US");
  assert.deepEqual(call.payload.parameters, []);
  assert.equal(call.payload.accessToken, "tok-1");
  assert.deepEqual(call.persistedPayload, { kind: "template", template, actorId: "actor-1" });
});

test("template command passes through explicit parameters and components", () => {
  const template = {
    templateName: "shipping_update",
    templateLanguage: "en_US",
    parameters: ["12345"],
    components: [{ type: "body", parameters: [{ type: "text", text: "12345" }] }]
  };
  const call = buildOutboundAdapterCall({ ...base, kind: "template", template }, channel);
  assert.deepEqual(call.payload.parameters, ["12345"]);
  assert.deepEqual(call.payload.components, template.components);
});

test("template kind without a payload falls back to text", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "template", text: "fallback" }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-text");
});

test("location command maps to send-location", () => {
  const location = { latitude: 37.4, longitude: -122.1, name: "HQ", address: "1600 Amphitheatre Pkwy" };
  const call = buildOutboundAdapterCall({ ...base, kind: "location", location }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-location");
  assert.equal(call.payload.phoneNumberId, "PN-1");
  assert.equal(call.payload.to, "+15551230000");
  assert.equal(call.payload.latitude, 37.4);
  assert.equal(call.payload.longitude, -122.1);
  // These keys must match exactly what both metaDispatch and the standalone
  // send-location HTTP route read (name/address), so the location name/address
  // are not silently dropped on the standalone-deployment path.
  assert.equal(call.payload.name, "HQ");
  assert.equal(call.payload.address, "1600 Amphitheatre Pkwy");
  assert.deepEqual(call.persistedPayload, { kind: "location", location, actorId: "actor-1" });
});

test("location kind without a payload falls back to text", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "location", text: "fallback" }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-text");
});

test("contacts command maps to send-contacts", () => {
  const contacts = [{ name: { formattedName: "Jane Doe" }, phones: [{ phone: "+15551230000" }] }];
  const call = buildOutboundAdapterCall({ ...base, kind: "contacts", contacts }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-contacts");
  assert.equal(call.payload.phoneNumberId, "PN-1");
  assert.equal(call.payload.to, "+15551230000");
  assert.deepEqual(call.payload.contacts, contacts);
  assert.deepEqual(call.persistedPayload, { kind: "contacts", contacts, actorId: "actor-1" });
});

test("contacts kind without a payload falls back to text", () => {
  const call = buildOutboundAdapterCall({ ...base, kind: "contacts", text: "fallback" }, channel);
  assert.equal(call.endpoint, "/internal/v1/whatsapp/send-text");
});
