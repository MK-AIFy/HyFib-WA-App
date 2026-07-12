import test from "node:test";
import assert from "node:assert/strict";
import { createDurableWebhookBus } from "../dist/webhook-outbox-bus.js";

function makeInner() {
  const calls = { publish: [], subscribe: [], close: 0 };
  return {
    calls,
    async publish(topic, payload, tenantId) {
      calls.publish.push({ topic, payload, tenantId });
      return { id: "inner-envelope", topic, payload, tenantId, occurredAt: "now" };
    },
    subscribe(topic, queue, handler, options) {
      calls.subscribe.push({ topic, queue, handler, options });
    },
    async close() {
      calls.close += 1;
    }
  };
}

function makeLogger() {
  const warn = [];
  return { logs: { warn }, debug() {}, info() {}, warn: (...args) => warn.push(args), error() {} };
}

test("resolvable phoneNumberId enqueues via the outbox and does not call inner.publish", async () => {
  const inner = makeInner();
  const logger = makeLogger();
  const enqueueCalls = [];
  const bus = createDurableWebhookBus(inner, {
    resolveTenant: async (phoneNumberId) => (phoneNumberId === "123" ? "tenant-uuid-1" : undefined),
    enqueue: async (tenantId, topic, payload) => {
      enqueueCalls.push({ tenantId, topic, payload });
    },
    logger
  });

  const payload = { phoneNumberId: "123", from: "+15550001111" };
  await bus.publish("whatsapp.inbound.received", payload, "waba-fallback-id");

  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0], {
    tenantId: "tenant-uuid-1",
    topic: "whatsapp.inbound.received",
    payload
  });
  assert.equal(inner.calls.publish.length, 0);
  assert.equal(logger.logs.warn.length, 0);
});

test("unresolvable phoneNumberId falls back to inner.publish, skips enqueue, and warns", async () => {
  const inner = makeInner();
  const logger = makeLogger();
  const enqueueCalls = [];
  const bus = createDurableWebhookBus(inner, {
    resolveTenant: async () => undefined,
    enqueue: async (tenantId, topic, payload) => {
      enqueueCalls.push({ tenantId, topic, payload });
    },
    logger
  });

  const payload = { phoneNumberId: "unknown-phone", from: "+15550001111" };
  await bus.publish("whatsapp.inbound.received", payload, "waba-fallback-id");

  assert.equal(enqueueCalls.length, 0);
  assert.equal(inner.calls.publish.length, 1);
  assert.deepEqual(inner.calls.publish[0], {
    topic: "whatsapp.inbound.received",
    payload,
    tenantId: "waba-fallback-id"
  });
  assert.equal(logger.logs.warn.length, 1);
  assert.equal(logger.logs.warn[0][0], "webhook_event_direct_publish");
});

test("payload without phoneNumberId takes the same fallback path (and skips resolveTenant)", async () => {
  const inner = makeInner();
  const logger = makeLogger();
  let resolveTenantCalls = 0;
  const enqueueCalls = [];
  const bus = createDurableWebhookBus(inner, {
    resolveTenant: async () => {
      resolveTenantCalls += 1;
      return "should-not-be-reached";
    },
    enqueue: async (tenantId, topic, payload) => {
      enqueueCalls.push({ tenantId, topic, payload });
    },
    logger
  });

  const payload = { status: "delivered" }; // no phoneNumberId field at all
  await bus.publish("whatsapp.status.updated", payload, "waba-fallback-id");

  assert.equal(resolveTenantCalls, 0);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(inner.calls.publish.length, 1);
  assert.deepEqual(inner.calls.publish[0], {
    topic: "whatsapp.status.updated",
    payload,
    tenantId: "waba-fallback-id"
  });
  assert.equal(logger.logs.warn.length, 1);
});

test("subscribe and close delegate to inner verbatim", async () => {
  const inner = makeInner();
  const logger = makeLogger();
  const bus = createDurableWebhookBus(inner, {
    resolveTenant: async () => undefined,
    enqueue: async () => {},
    logger
  });

  const handler = async () => {};
  const options = { ephemeral: true };
  bus.subscribe("whatsapp.inbound.received", "queue-1", handler, options);
  assert.equal(inner.calls.subscribe.length, 1);
  assert.deepEqual(inner.calls.subscribe[0], {
    topic: "whatsapp.inbound.received",
    queue: "queue-1",
    handler,
    options
  });

  await bus.close();
  assert.equal(inner.calls.close, 1);
});

test("enqueue throwing propagates (not swallowed) so the caller can 502", async () => {
  const inner = makeInner();
  const logger = makeLogger();
  const bus = createDurableWebhookBus(inner, {
    resolveTenant: async () => "tenant-uuid-1",
    enqueue: async () => {
      throw new Error("db_insert_failed");
    },
    logger
  });

  await assert.rejects(
    () => bus.publish("whatsapp.inbound.received", { phoneNumberId: "123" }, "waba-fallback-id"),
    /db_insert_failed/
  );
  assert.equal(inner.calls.publish.length, 0);
});
