import test from "node:test";
import assert from "node:assert/strict";
import { mapMediaUploadProxyResult } from "../dist/media-upload.js";

test("2xx with a mediaId maps to uploaded", () => {
  const outcome = mapMediaUploadProxyResult(201, { requestId: "r1", mediaId: "mid-1" });
  assert.deepEqual(outcome, { kind: "uploaded", mediaId: "mid-1" });
});

test("2xx without a mediaId maps to 502 media_upload_failed (unusable adapter response)", () => {
  const outcome = mapMediaUploadProxyResult(201, { requestId: "r1" });
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 502);
  assert.equal(outcome.body.error, "media_upload_failed");
});

test("adapter 400 passes through verbatim so the real validation reason reaches the client", () => {
  const body = { error: "Content-Type must be the media MIME type (e.g. image/jpeg)" };
  const outcome = mapMediaUploadProxyResult(400, body);
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.body, body);
});

test("adapter 413 passes through with its maxBytes hint intact", () => {
  const body = { error: "media_too_large", maxBytes: 16777216 };
  const outcome = mapMediaUploadProxyResult(413, body);
  assert.equal(outcome.status, 413);
  assert.equal(outcome.body.maxBytes, 16777216);
});

test("adapter 401/403 (internal auth misconfig) is NOT passed through — client did nothing wrong", () => {
  for (const status of [401, 403]) {
    const outcome = mapMediaUploadProxyResult(status, { error: "internal_auth_failed" });
    assert.equal(outcome.status, 502);
    assert.equal(outcome.body.error, "media_upload_failed");
  }
});

test("adapter 503 maps to 503 meta_adapter_unavailable carrying the details string", () => {
  const outcome = mapMediaUploadProxyResult(503, {
    error: "meta_adapter_unavailable",
    details: "upload_deadline_exceeded"
  });
  assert.equal(outcome.status, 503);
  assert.deepEqual(outcome.body, { error: "meta_adapter_unavailable", detail: "upload_deadline_exceeded" });
});

test("adapter 502 meta_media_upload_failed maps to the gateway's media_upload_failed contract", () => {
  const outcome = mapMediaUploadProxyResult(502, { error: "meta_media_upload_failed", details: { message: "bad" } });
  assert.equal(outcome.status, 502);
  assert.deepEqual(outcome.body, { error: "media_upload_failed", detail: "meta_media_upload_failed" });
});
