import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAi } from "../dist/index.js";

test("dispatchAi lead-score returns a deterministic 0-100 score", async () => {
  const raw = JSON.stringify({ recencyDays: 5, engagementScore: 80, purchaseCount: 3, averageOrderValue: 5000 });
  const res = await dispatchAi("lead-score", "POST", raw, "req-1");
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.score, "number");
  assert.ok(res.body.score >= 0 && res.body.score <= 100);
  assert.equal(res.body.scale, "0-100");
});

test("dispatchAi lead-score rejects out-of-range inputs with 400", async () => {
  const raw = JSON.stringify({ recencyDays: -1, engagementScore: 80, purchaseCount: 3, averageOrderValue: 5000 });
  const res = await dispatchAi("lead-score", "POST", raw, "req-2");
  assert.equal(res.status, 400);
});

test("dispatchAi rejects non-POST with 405", async () => {
  const res = await dispatchAi("lead-score", "GET", undefined, "req-3");
  assert.equal(res.status, 405);
});

test("dispatchAi returns 404 for an unknown ai path", async () => {
  const res = await dispatchAi("does-not-exist", "POST", "{}", "req-4");
  assert.equal(res.status, 404);
});
