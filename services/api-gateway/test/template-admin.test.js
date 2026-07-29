import test from "node:test";
import assert from "node:assert/strict";
import { mapTemplateAdminProxyResult, validateTemplatePatch } from "../dist/template-admin.js";

// ─── mapTemplateAdminProxyResult ────────────────────────────────────────────

test("2xx maps to ok with the body preserved", () => {
  const outcome = mapTemplateAdminProxyResult(200, { id: "123", status: "pending" }, "template_submit_failed");
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.body.id, "123");
});

test("adapter 4xx validation errors pass through verbatim", () => {
  const outcome = mapTemplateAdminProxyResult(400, { error: "wabaId is required" }, "template_submit_failed");
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.body.error, "wabaId is required");
});

test("Meta 401/403 become 502 so they cannot masquerade as gateway auth responses", () => {
  for (const status of [401, 403]) {
    const outcome = mapTemplateAdminProxyResult(status, { error: "unauthorized" }, "template_submit_failed");
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.status, 502);
    assert.equal(outcome.body.error, "template_submit_failed");
  }
});

test("503 maps to meta_adapter_unavailable and prefers string details", () => {
  const outcome = mapTemplateAdminProxyResult(
    503,
    { error: "meta_adapter_unavailable", details: "connect ECONNREFUSED" },
    "template_edit_failed"
  );
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 503);
  assert.deepEqual(outcome.body, { error: "meta_adapter_unavailable", detail: "connect ECONNREFUSED" });
});

test("adapter 502 becomes the caller's fallback error and surfaces the Graph message", () => {
  const outcome = mapTemplateAdminProxyResult(
    502,
    { error: "meta_template_submit_failed", details: { message: "(#100) Invalid parameter", code: 100 } },
    "template_submit_failed"
  );
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 502);
  assert.deepEqual(outcome.body, { error: "template_submit_failed", detail: "(#100) Invalid parameter" });
});

// ─── validateTemplatePatch ──────────────────────────────────────────────────

test("a valid patch with category and body trims and passes", () => {
  const result = validateTemplatePatch({ category: "utility", body: "  Hi {{1}}  " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { category: "utility", body: "Hi {{1}}" });
});

test("at least one of category or body is required (channelId alone is not a change)", () => {
  for (const payload of [{}, { channelId: "11111111-1111-1111-1111-111111111111" }]) {
    const result = validateTemplatePatch(payload);
    assert.equal(result.ok, false);
    assert.match(result.error, /category or body/);
  }
});

test("unknown category is rejected", () => {
  const result = validateTemplatePatch({ category: "spam" });
  assert.equal(result.ok, false);
  assert.match(result.error, /category must be one of/);
});

test("body over 1024 chars is rejected", () => {
  const result = validateTemplatePatch({ body: "x".repeat(1025) });
  assert.equal(result.ok, false);
  assert.match(result.error, /1024/);
});

test("empty or non-string body is rejected", () => {
  for (const body of ["", "   ", 42, null]) {
    const result = validateTemplatePatch({ body });
    assert.equal(result.ok, false);
  }
});

test("malformed channelId is rejected when present", () => {
  const result = validateTemplatePatch({ body: "Hi", channelId: "not-a-uuid" });
  assert.equal(result.ok, false);
  assert.match(result.error, /channelId/);
});

test("non-object payloads are rejected", () => {
  for (const payload of [null, "x", [1]]) {
    const result = validateTemplatePatch(payload);
    assert.equal(result.ok, false);
  }
});
