import test from "node:test";
import assert from "node:assert/strict";
import {
  sendTemplateDirect,
  markReadDirect,
  sendTypingIndicatorDirect,
  metaDispatch,
  uploadMediaDirect
} from "../dist/index.js";

test("sendTemplateDirect returns 400 when required fields are missing", async () => {
  const res = await sendTemplateDirect({ phoneNumberId: "PNID" }, "req-1");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Missing required fields for template send");
});

test("markReadDirect returns 400 when phoneNumberId/messageId are missing", async () => {
  const res = await markReadDirect({ phoneNumberId: "PNID" }, "req-2");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "phoneNumberId and messageId are required");
});

test("sendTypingIndicatorDirect returns 400 when phoneNumberId/messageId are missing", async () => {
  const res = await sendTypingIndicatorDirect({ phoneNumberId: "PNID" }, "req-3");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "phoneNumberId and messageId are required");
});

// metaDispatch is the in-process path used by the app-server monolith (the
// worker calls it directly instead of the HTTP server). Its per-kind required
// field guards are a SEPARATE code path from the standalone HTTP routes tested
// in http-routes.test.js, so they need their own coverage. Each of these
// returns 400 before any Graph API call, so no network/token is required.

test("metaDispatch send-location returns 400 when latitude/longitude are missing", async () => {
  const res = await metaDispatch("/internal/v1/whatsapp/send-location", { phoneNumberId: "PN", to: "+1555" }, "req-l1");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /latitude/);
});

test("metaDispatch send-location returns 400 when latitude is non-finite", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-location",
    { phoneNumberId: "PN", to: "+1555", latitude: Infinity, longitude: 0 },
    "req-l2"
  );
  assert.equal(res.status, 400);
});

test("metaDispatch send-contacts returns 400 when contacts is empty", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-contacts",
    { phoneNumberId: "PN", to: "+1555", contacts: [] },
    "req-c1"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /contact/);
});

test("metaDispatch send-contacts returns 400 when a contact is missing name.formattedName", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-contacts",
    { phoneNumberId: "PN", to: "+1555", contacts: [{ name: {} }] },
    "req-c2"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /formattedName/);
});

test("metaDispatch send-interactive cta_url returns 400 when ctaUrl is missing", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-interactive",
    { phoneNumberId: "PN", to: "+1555", interactiveType: "cta_url", bodyText: "hi", ctaDisplayText: "Visit" },
    "req-i1"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ctaUrl/);
});

test("metaDispatch send-interactive cta_url returns 400 when ctaDisplayText is missing", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-interactive",
    { phoneNumberId: "PN", to: "+1555", interactiveType: "cta_url", bodyText: "hi", ctaUrl: "https://example.com" },
    "req-i2"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ctaDisplayText/);
});

test("metaDispatch returns 404 for an unknown endpoint", async () => {
  const res = await metaDispatch(
    "/internal/v1/whatsapp/send-nonexistent",
    { phoneNumberId: "PN", to: "+1555" },
    "req-x"
  );
  assert.equal(res.status, 404);
});

// uploadMediaDirect is the in-process media upload used by the gateway in the
// monolith (the standalone HTTP route delegates to it). Each guard returns 400
// before any Graph API call, so no network/token is required.

test("uploadMediaDirect returns 400 for an empty-string phoneNumberId (?? keeps it; no env fallback applies)", async () => {
  const res = await uploadMediaDirect({ buffer: Buffer.from("x"), mimeType: "image/png", phoneNumberId: "" }, "req-m1");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /phoneNumberId/);
});

test("uploadMediaDirect returns 400 when mimeType is missing", async () => {
  const res = await uploadMediaDirect({ buffer: Buffer.from("x"), mimeType: "", phoneNumberId: "PN" }, "req-m2");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /MIME type/);
});

test("uploadMediaDirect returns 400 for a JSON mimeType (bytes must be raw media)", async () => {
  const res = await uploadMediaDirect(
    { buffer: Buffer.from("{}"), mimeType: "application/json", phoneNumberId: "PN" },
    "req-m3"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /MIME type/);
});

test("uploadMediaDirect returns 400 when the buffer is empty", async () => {
  const res = await uploadMediaDirect(
    { buffer: Buffer.alloc(0), mimeType: "image/png", phoneNumberId: "PN" },
    "req-m4"
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /file bytes/);
});

test("uploadMediaDirect returns 413 when the buffer exceeds the 16MB cap (no Graph call)", async () => {
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
  const res = await uploadMediaDirect({ buffer: oversized, mimeType: "image/png", phoneNumberId: "PN" }, "req-m5");
  assert.equal(res.status, 413);
  assert.equal(res.body.error, "media_too_large");
  assert.equal(res.body.maxBytes, 16 * 1024 * 1024);
});
