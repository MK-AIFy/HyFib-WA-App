import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import {
  autoReplyRuleRepository,
  automationRuleRepository,
  automationSettingsRepository,
  channelRepository,
  consentRepository,
  contactRepository,
  conversationRepository,
  flowRepository,
  messageRepository,
  sequenceRepository,
  whatsappSettingsRepository
} from "@hyfib/persistence";
import { EventTopics, renderMetrics } from "@hyfib/shared-core";

/**
 * How handleInbound applies an inbound STOP/START, driven through the real consumer with the shared
 * repository singletons patched (the technique replay.test.js and inbound-credential-failure.test.js use);
 * no Postgres or Redis is touched.
 *
 * The message row is the replay guard's marker: once it exists, an outbox redelivery skips the whole handler.
 * A STOP applied after that row — or half-applied because a later step threw — was therefore lost for good.
 * The fake findByExternalId mirrors that: a row is findable as soon as create has committed it.
 */

const HEALTHY_CREDENTIALS = { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" };

function createFakeBus() {
  const handlers = new Map();
  const published = [];
  return {
    handlers,
    published,
    subscribe(topic, _queue, handler) {
      handlers.set(topic, handler);
    },
    async publish(topic, payload, tenantId) {
      published.push({ topic, payload, tenantId });
    },
    async close() {}
  };
}

/** Collects the structured JSON log lines the shared logger writes to stdout. */
function captureLogs() {
  const entries = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // not a structured log line
      }
    }
    return true;
  };
  return {
    entries,
    restore: () => {
      process.stdout.write = original;
    }
  };
}

/** Swaps methods on a shared repository singleton; returns a function that restores them. */
function patch(target, impls) {
  const originals = {};
  for (const [key, impl] of Object.entries(impls)) {
    originals[key] = target[key];
    target[key] = impl;
  }
  return () => Object.assign(target, originals);
}

/** Returns a function that throws `message` for its first `times` calls and is a no-op afterwards. */
function failFirst(times, message) {
  let remaining = times;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error(message);
    }
  };
}

/** Current value of one counter series in the Prometheus text the worker exposes (0 if it does not exist yet). */
function counterValue(name, labels) {
  const series = `${name}{${labels}}`;
  const line = renderMetrics()
    .split("\n")
    .find((candidate) => candidate.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

/**
 * Wires the real worker consumers to recording stubs for a brand-new contact whose conversation is already
 * assigned (so round-robin is skipped). `steps` records the order of the side effects the replay guard cares
 * about; the failure knobs make one transient step throw a fixed number of times.
 */
function harness({ setOptedOutFailures = 0, mediaEnqueueFailures = 0 } = {}) {
  const steps = [];
  const recorded = new Set();
  const state = { optedOut: false };
  const calls = { revoke: [], grant: [], setOptedOut: [], createMessage: 0, autoReplyList: 0 };
  const failSetOptedOut = failFirst(setOptedOutFailures, "set_opted_out_failed");
  const failMediaEnqueue = failFirst(mediaEnqueueFailures, "media_enqueue_failed");
  const bus = createFakeBus();
  const restores = [
    patch(messageRepository, {
      findByExternalId: async (_tenantId, externalId) =>
        recorded.has(externalId) ? { id: "msg-1", conversationId: "conv-1", payload: {} } : undefined,
      create: async (_tenantId, input) => {
        steps.push("message.create");
        calls.createMessage += 1;
        recorded.add(input.externalMessageId);
        return { id: "msg-1" };
      }
    }),
    patch(contactRepository, {
      findOrCreateByPhone: async () => ({ id: "contact-1", phoneE164: "+15559998888" }),
      setOptedOut: async (...args) => {
        steps.push(`setOptedOut:${args[2]}`);
        calls.setOptedOut.push(args);
        failSetOptedOut();
        state.optedOut = args[2];
      }
    }),
    patch(conversationRepository, {
      findOrCreate: async () => ({ id: "conv-1", assignedUserId: "user-1" }),
      touchInbound: async () => {}
    }),
    patch(consentRepository, {
      revoke: async (...args) => {
        steps.push("revoke");
        calls.revoke.push(args);
      },
      grant: async (...args) => {
        steps.push("grant");
        calls.grant.push(args);
      }
    }),
    patch(channelRepository, { getCredentials: async () => HEALTHY_CREDENTIALS }),
    patch(whatsappSettingsRepository, { getByTenant: async () => undefined }),
    patch(sequenceRepository, { stopActiveForContact: async () => 0 }),
    patch(automationSettingsRepository, { get: async () => undefined }),
    patch(flowRepository, {
      activeSessionForConversation: async () => undefined,
      findByTrigger: async () => undefined
    }),
    patch(autoReplyRuleRepository, {
      listEnabled: async () => {
        calls.autoReplyList += 1;
        return [];
      }
    }),
    patch(automationRuleRepository, { listEnabledByTrigger: async () => [] })
  ];
  registerWorkerConsumers({
    eventBus: bus,
    metaClient: {
      async send() {
        throw new Error("unexpected send");
      },
      async markRead() {},
      async fetchMedia() {
        throw new Error("unexpected fetchMedia");
      }
    },
    resolveChannel: async () => ({ tenantId: "t-1", channelId: "c-1" }),
    enqueueMediaFetch: async () => {
      failMediaEnqueue();
    }
  });
  return {
    bus,
    calls,
    steps,
    state,
    handleInbound: bus.handlers.get(EventTopics.WhatsAppInboundReceived),
    restore: () => restores.reverse().forEach((restore) => restore())
  };
}

let nextMessage = 0;

function inboundEvent(overrides = {}) {
  return {
    id: "env-1",
    topic: EventTopics.WhatsAppInboundReceived,
    occurredAt: new Date().toISOString(),
    payload: {
      phoneNumberId: "PN-1",
      from: "+15559998888",
      messageId: `wamid.auto-${(nextMessage += 1)}`,
      type: "text",
      text: "hello",
      ...overrides
    }
  };
}

/** Delivers one inbound event; returns whatever the handler threw (if anything) plus its log lines. */
async function deliver(h, overrides) {
  const logs = captureLogs();
  let error;
  try {
    await h.handleInbound(inboundEvent(overrides));
  } catch (caught) {
    error = caught;
  } finally {
    logs.restore();
  }
  return { error, logs: logs.entries };
}

const isOptOutEvent = (event) => event.topic === EventTopics.ComplianceOptOutEvent;

test("handleInbound: an inbound STOP is applied before the message row (the replay marker) is written", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, { text: "STOP" });

    assert.equal(error, undefined);
    assert.deepEqual(h.steps, ["revoke", "setOptedOut:true", "message.create"]);
    assert.ok(h.bus.published.some(isOptOutEvent), "the compliance opt-out event must still be published");
    assert.equal(h.calls.autoReplyList, 0, "no auto-reply after a STOP");
  } finally {
    h.restore();
  }
});

test("handleInbound: a STOP is not lost when a step after the message row is written throws", async () => {
  // A captioned image: the media enqueue runs after the row is committed and fails transiently.
  const h = harness({ mediaEnqueueFailures: 1 });
  const image = { type: "image", text: "STOP", messageId: "wamid.stop-media", media: { id: "media-1" } };
  try {
    const first = await deliver(h, image);
    assert.match(first.error?.message ?? "", /media_enqueue_failed/, "the failure must still fail the delivery");

    // The outbox redelivers; the replay guard now finds the committed row and skips the handler.
    const second = await deliver(h, image);
    assert.equal(second.error, undefined);

    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]], "consent must be revoked exactly once");
    assert.equal(h.state.optedOut, true, "the contact must end up opted out");
  } finally {
    h.restore();
  }
});

test("handleInbound: a half-applied STOP is retried, not skipped as a replay", async () => {
  const h = harness({ setOptedOutFailures: 1 });
  const stop = { text: "STOP", messageId: "wamid.stop-half" };
  try {
    const first = await deliver(h, stop);
    assert.match(first.error?.message ?? "", /set_opted_out_failed/);
    assert.equal(
      h.calls.createMessage,
      0,
      "no message row may exist yet: it would make the redelivery look like an already-handled replay"
    );

    const second = await deliver(h, stop);
    assert.equal(second.error, undefined);
    assert.equal(h.state.optedOut, true, "the redelivery must finish the opt-out");
    assert.equal(h.calls.createMessage, 1, "and record the message once");
  } finally {
    h.restore();
  }
});

test("handleInbound: a 'Stop promotions' quick-reply tap is honoured as an opt-out", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, {
      type: "button",
      text: "Stop promotions",
      button: { text: "Stop promotions", payload: "STOP_PROMOTIONS" }
    });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]]);
    assert.equal(h.state.optedOut, true);
    assert.ok(h.bus.published.some(isOptOutEvent));
  } finally {
    h.restore();
  }
});

test("handleInbound: an ordinary sentence containing an opt-out word does not opt the customer out", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, { text: "Can you cancel my order?" });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, []);
    assert.deepEqual(h.calls.setOptedOut, []);
    assert.equal(h.bus.published.some(isOptOutEvent), false);
    assert.equal(h.calls.autoReplyList, 1, "the message must carry on to auto-reply evaluation");
  } finally {
    h.restore();
  }
});

test("handleInbound: a shared location named after an opt-out word is not an opt-out", async () => {
  // The webhook normaliser turns a location pin's name into `text`; a place name is not the customer's words.
  const h = harness();
  try {
    const { error } = await deliver(h, {
      type: "location",
      text: "Stop",
      location: { latitude: 12.97, longitude: 77.59, name: "Stop" }
    });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, []);
    assert.deepEqual(h.calls.setOptedOut, []);
  } finally {
    h.restore();
  }
});

test("handleInbound: START re-consents and the message carries on to auto-reply evaluation", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, { text: "START" });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.grant, [["t-1", "contact-1", { source: "inbound_start", policyVersion: "v1" }]]);
    assert.deepEqual(h.calls.setOptedOut, [["t-1", "contact-1", false]]);
    assert.equal(h.calls.autoReplyList, 1);
  } finally {
    h.restore();
  }
});

test("handleInbound: a bare yes does not re-consent an opted-out contact", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, { text: "yes" });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.grant, []);
    assert.deepEqual(h.calls.setOptedOut, []);
  } finally {
    h.restore();
  }
});

test("handleInbound: stop-like text that is not honoured is logged and counted, without the message text", async () => {
  const h = harness();
  const before = counterValue("inbound_possible_opt_outs_total", 'type="text"');
  try {
    const { error, logs } = await deliver(h, { text: "Stop, wrong number", messageId: "wamid.possible-1" });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, [], "it is deliberately not treated as an opt-out");
    const entry = logs.find((line) => line.message === "inbound_possible_opt_out");
    assert.ok(entry, "the declined stop-like message must be visible to operators");
    assert.equal(entry.level, "info");
    assert.equal(entry.tenantId, "t-1");
    assert.equal(entry.contactId, "contact-1");
    assert.equal(entry.messageId, "wamid.possible-1");
    assert.equal(entry.type, "text");
    assert.ok(!JSON.stringify(entry).includes("wrong number"), "the customer's text must not be logged");
    assert.equal(counterValue("inbound_possible_opt_outs_total", 'type="text"'), before + 1);
  } finally {
    h.restore();
  }
});

test("handleInbound: ordinary text and honoured opt-outs are not reported as possible opt-outs", async () => {
  const h = harness();
  const before = counterValue("inbound_possible_opt_outs_total", 'type="text"');
  try {
    const plain = await deliver(h, { text: "what are your prices?" });
    const honoured = await deliver(h, { text: "STOP" });
    const startWord = await deliver(h, { text: "Can you stop by tomorrow?" });

    for (const { error } of [plain, honoured, startWord]) {
      assert.equal(error, undefined);
    }
    const reported = [plain, honoured, startWord].map(({ logs }) =>
      logs.some((line) => line.message === "inbound_possible_opt_out")
    );
    assert.deepEqual(reported, [false, false, true], "only the declined 'stop' sentence is reported");
    assert.equal(counterValue("inbound_possible_opt_outs_total", 'type="text"'), before + 1);
  } finally {
    h.restore();
  }
});
