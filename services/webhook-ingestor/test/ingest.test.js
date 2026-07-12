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
  const releases = [];
  return {
    releases,
    async isDuplicate(key) {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    },
    async release(key) {
      releases.push(key);
      seen.delete(key);
    }
  };
}

/** A bus whose publish() throws on its Nth call (1-indexed), succeeding otherwise. */
function fakeBusFailingOnCall(failOnCall) {
  const published = [];
  let calls = 0;
  return {
    published,
    async publish(topic, payload, tenantId) {
      calls += 1;
      if (calls === failOnCall) {
        throw new Error("db down");
      }
      published.push({ topic, payload, tenantId });
      return { topic, payload };
    },
    subscribe() {},
    async close() {}
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

test("a failed inbound publish releases exactly the inbound message's key and rethrows; retry reprocesses", async () => {
  // First publish() call is the inbound message loop's publish for wamid.1.
  const bus = fakeBusFailingOnCall(1);
  const idem = fakeIdempotency();

  await assert.rejects(
    () => ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem }),
    /db down/
  );
  // The status loop never runs because the inbound publish threw first.
  assert.deepEqual(idem.releases, ["inbound:wamid.1"]);
  assert.equal(bus.published.length, 0);

  // Retry (Meta re-delivering the same webhook): the released key can be
  // re-claimed, and since the bus only fails on its 1st call, this succeeds.
  const summary = await ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem });
  assert.deepEqual(summary, { inbound: 1, statuses: 1, duplicates: 0 });
  assert.equal(bus.published.length, 2);
});

test("a failed status publish releases exactly the status's key and rethrows; retry reprocesses", async () => {
  // Second publish() call is the status-updates loop's publish (inbound succeeds first).
  const bus = fakeBusFailingOnCall(2);
  const idem = fakeIdempotency();

  await assert.rejects(
    () => ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem }),
    /db down/
  );
  assert.deepEqual(idem.releases, ["status:wamid.1:delivered"]);
  // The inbound message's publish succeeded and was NOT released.
  assert.equal(bus.published.length, 1);
  assert.equal(bus.published[0].topic.toLowerCase().includes("status"), false);

  // Retry: inbound is now a duplicate (its key is still claimed), but the
  // released status key can be re-claimed and republished.
  const summary = await ingestMetaWebhook(payload, "tenant-1", { eventBus: bus, idempotency: idem });
  assert.deepEqual(summary, { inbound: 0, statuses: 1, duplicates: 1 });
  assert.equal(bus.published.length, 2);
});
