import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../dist/index.js";

/**
 * These tests boot the REAL standalone HTTP server (never listening on the
 * production port — `server` is only imported here, not started via isMain)
 * and assert every send-* route is actually registered, distinguishing a
 * registered-but-invalid request (400) from a missing route (404). This is
 * the class of bug a metaDispatch-only test can't catch: a switch case
 * added without its matching `if (path === ...)` HTTP block ships silently
 * (see the send-location/send-contacts gap this test was added to prevent).
 */

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("an unregistered path returns 404 (control — proves the test can detect a missing route)", async () => {
  const res = await post("/internal/v1/whatsapp/send-nonexistent-kind", {});
  assert.equal(res.status, 404);
});

test("send-location is registered and validates required fields (400, not 404)", async () => {
  const res = await post("/internal/v1/whatsapp/send-location", {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /latitude/);
});

test("send-contacts is registered and validates required fields (400, not 404)", async () => {
  const res = await post("/internal/v1/whatsapp/send-contacts", {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /contact/);
});

test("send-typing is registered and validates required fields (400, not 404)", async () => {
  const res = await post("/internal/v1/whatsapp/send-typing", {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /phoneNumberId/);
});

test("send-interactive cta_url requires ctaUrl (400, not 404), rejecting the empty-parameters bug", async () => {
  const res = await post("/internal/v1/whatsapp/send-interactive", {
    phoneNumberId: "PN-1",
    to: "+15551230000",
    interactiveType: "cta_url",
    bodyText: "Check us out"
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ctaUrl/);
});

test("send-interactive cta_url requires ctaDisplayText even when ctaUrl is present (400, not a malformed Meta payload)", async () => {
  const res = await post("/internal/v1/whatsapp/send-interactive", {
    phoneNumberId: "PN-1",
    to: "+15551230000",
    interactiveType: "cta_url",
    bodyText: "Check us out",
    ctaUrl: "https://example.com"
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ctaDisplayText/);
});

test("media upload is registered and rejects a JSON content-type (400, not 404)", async () => {
  const response = await fetch(`${baseUrl}/internal/v1/whatsapp/media?phoneNumberId=PN-1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /MIME type/);
});

test("media upload with an empty body returns 400 (file bytes required, proving route→direct delegation)", async () => {
  const response = await fetch(`${baseUrl}/internal/v1/whatsapp/media?phoneNumberId=PN-1`, {
    method: "POST",
    headers: { "Content-Type": "image/png" }
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /file bytes/);
});

test("media upload over the 16MB cap receives a delivered 413 with maxBytes (socket not destroyed first)", async () => {
  const response = await fetch(`${baseUrl}/internal/v1/whatsapp/media?phoneNumberId=PN-1`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: Buffer.alloc(16 * 1024 * 1024 + 1)
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, "media_too_large");
  assert.equal(body.maxBytes, 16 * 1024 * 1024);
});
