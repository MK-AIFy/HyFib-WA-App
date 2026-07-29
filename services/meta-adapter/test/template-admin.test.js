import test from "node:test";
import assert from "node:assert/strict";
import { submitTemplateDirect, editTemplateDirect, deleteTemplateDirect } from "../dist/index.js";

// Direct in-process template-admin seam (roadmap A3). Validation guards run
// before any Graph call; the "valid payload, no token" cases prove the
// error-mapping path without touching the network (graphRequest throws
// synchronously when no access token is configured → 503).

test("submitTemplateDirect returns 400 when required fields are missing", async () => {
  const res = await submitTemplateDirect({ wabaId: "WABA" }, "req-ts1");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name/);
});

test("submitTemplateDirect returns 400 when bodyText is missing", async () => {
  const res = await submitTemplateDirect(
    { wabaId: "WABA", name: "promo", language: "en", category: "marketing" },
    "req-ts2"
  );
  assert.equal(res.status, 400);
});

test("submitTemplateDirect maps a missing access token to 503 without calling Meta", async () => {
  const res = await submitTemplateDirect(
    { wabaId: "WABA", name: "promo", language: "en", category: "marketing", bodyText: "Hello {{1}}" },
    "req-ts3"
  );
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "meta_adapter_unavailable");
});

test("editTemplateDirect returns 400 when metaTemplateId is missing", async () => {
  const res = await editTemplateDirect({ bodyText: "Hi" }, "req-te1");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /metaTemplateId/);
});

test("editTemplateDirect returns 400 when no change field is provided", async () => {
  const res = await editTemplateDirect({ metaTemplateId: "12345" }, "req-te2");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /category or bodyText/);
});

test("editTemplateDirect maps a missing access token to 503 without calling Meta", async () => {
  const res = await editTemplateDirect({ metaTemplateId: "12345", bodyText: "Hi" }, "req-te3");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "meta_adapter_unavailable");
});

test("deleteTemplateDirect returns 400 when wabaId or name is missing", async () => {
  const res = await deleteTemplateDirect({ wabaId: "WABA" }, "req-td1");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name/);
});

test("deleteTemplateDirect maps a missing access token to 503 without calling Meta", async () => {
  const res = await deleteTemplateDirect({ wabaId: "WABA", name: "promo" }, "req-td2");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "meta_adapter_unavailable");
});
