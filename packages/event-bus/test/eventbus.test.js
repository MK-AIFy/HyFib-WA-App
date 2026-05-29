import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus, createEventBus } from "../dist/index.js";

test("InMemoryEventBus delivers a published event to subscribers", async () => {
  const bus = new InMemoryEventBus();
  const received = [];
  bus.subscribe("whatsapp.inbound.received", "test-queue", (event) => {
    received.push(event);
  });

  const published = await bus.publish("whatsapp.inbound.received", { from: "+123" }, "tenant-1");

  assert.equal(received.length, 1);
  assert.equal(received[0].topic, "whatsapp.inbound.received");
  assert.equal(received[0].tenantId, "tenant-1");
  assert.deepEqual(received[0].payload, { from: "+123" });
  assert.equal(received[0].id, published.id);
  assert.ok(received[0].occurredAt);
});

test("InMemoryEventBus does not deliver across different topics", async () => {
  const bus = new InMemoryEventBus();
  let count = 0;
  bus.subscribe("campaign.dispatch.requested", "q", () => {
    count += 1;
  });
  await bus.publish("whatsapp.status.updated", {}, "t");
  assert.equal(count, 0);
});

test("createEventBus returns the in-memory transport when configured", () => {
  const bus = createEventBus({ eventBus: "memory", rabbitmqUrl: "amqp://unused" });
  assert.equal(bus instanceof InMemoryEventBus, true);
});
