import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";

test("registerWorkerConsumers subscribes all worker topics on the injected bus", () => {
  const subscriptions = [];
  const fakeBus = {
    subscribe(topic, queue) {
      subscriptions.push({ topic, queue });
    },
    async publish() {},
    async close() {}
  };

  registerWorkerConsumers({ eventBus: fakeBus });

  const queues = subscriptions.map((s) => s.queue).sort();
  assert.deepEqual(queues, [
    "automation-templates",
    "campaign-dispatch",
    "campaign-results",
    "campaign-run",
    "inbound-messages",
    "media-fetch",
    "outbound-messages",
    "status-updates"
  ]);
});
