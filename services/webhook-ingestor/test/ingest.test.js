import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ingestMetaWebhook, processForwardedWebhook } from "../dist/ingest.js";

function fakeBus() {
  return {
    published: [],
    async publish(topic, payload, tenantId) {
      this.published.push({ topic, payload, tenantId });
      return { topic, payload };
    },
    subscribe() {},
    async close() {}
  };
}

function fakeIdempotency() {
  const seen = new Set();
  return {
    async isDuplicate(key) {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    }
  };
}

const payload = {
  entry: [
    {
      id: "waba-tenant-1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PNID" },
            contacts: [{ wa_id: "15551230000", profile: { name: "Alice" } }],
            messages: [{ id: "wamid.1", from: "15551230000", type: "text", text: { body: "hi" }, timestamp: "1" }],
            statuses: [{ id: "wamid.1", status: "delivered", recipient_id: "15551230000", timestamp: "2" }]
          }
        }
      ]
    }
  ]
};

test("ingestMetaWebhook publishes inbound + status events on the injected bus", async () => {
  const bus = fakeBus();
  const summary = await ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: fakeIdempotency() });
  assert.deepEqual(summary, { inbound: 1, statuses: 1, duplicates: 0 });
  assert.equal(bus.published.length, 2);
  assert.equal(bus.published[0].tenantId, "tenant-1");
});

test("ingestMetaWebhook deduplicates repeated message ids", async () => {
  const bus = fakeBus();
  const idem = fakeIdempotency();
  await ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem });
  const second = await ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem });
  assert.deepEqual(second, { inbound: 0, statuses: 0, duplicates: 2 });
  assert.equal(bus.published.length, 2);
});

test("processForwardedWebhook verifies a correctly signed body then ingests", async () => {
  const secret = "s3cret";
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const bus = fakeBus();
  const result = await processForwardedWebhook(
    { rawBody, signature },
    { eventBus: bus, idempotency: fakeIdempotency(), metaAppSecret: secret }
  );
  assert.equal(result.verified, true);
  assert.deepEqual(result.summary, { inbound: 1, statuses: 1, duplicates: 0 });
  assert.equal(bus.published.length, 2);
});

test("processForwardedWebhook rejects an invalid signature without publishing", async () => {
  const rawBody = JSON.stringify(payload);
  const bus = fakeBus();
  const result = await processForwardedWebhook(
    { rawBody, signature: "sha256=deadbeef" },
    { eventBus: bus, idempotency: fakeIdempotency(), metaAppSecret: "s3cret" }
  );
  assert.equal(result.verified, false);
  assert.equal(bus.published.length, 0);
});
