import test from "node:test";
import assert from "node:assert/strict";
import { createIngestWebhookProxy } from "../dist/ingest-proxy.js";

test("verified webhook maps to ok:true, HTTP-equivalent status 200, and body.status accepted", async () => {
  const proxy = createIngestWebhookProxy(async () => ({
    verified: true,
    summary: { inbound: 2, statuses: 1, duplicates: 0 }
  }));

  const result = await proxy({ rawBody: "{}", signature: "sha256=abc" });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200, "in-process path must report the HTTP-equivalent 200 for gateway observability");
  assert.deepEqual(result.body, { status: "accepted", inbound: 2, statuses: 1, duplicates: 0 });
});

test("rejected signature maps to ok:false, HTTP-equivalent status 401, and body.status invalid_signature", async () => {
  const proxy = createIngestWebhookProxy(async () => ({ verified: false, summary: {} }));

  const result = await proxy({ rawBody: "{}", signature: "sha256=bad" });

  assert.equal(result.ok, false);
  assert.equal(
    result.status,
    401,
    "signature rejection must be distinguishable from 5xx-processing in webhook_upstream_failed logs"
  );
  assert.deepEqual(result.body, { status: "invalid_signature" });
});

test("forwarded webhook payload reaches processWebhook verbatim", async () => {
  const seen = [];
  const proxy = createIngestWebhookProxy(async (forwarded) => {
    seen.push(forwarded);
    return { verified: true, summary: {} };
  });

  await proxy({ rawBody: '{"entry":[]}', signature: "sha256=abc", tenantId: "t-1" });

  assert.deepEqual(seen, [{ rawBody: '{"entry":[]}', signature: "sha256=abc", tenantId: "t-1" }]);
});
