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
import { EventTopics } from "@hyfib/shared-core";

/**
 * Regression: the inbound read receipt is documented as best-effort, but an unguarded
 * `resolveSendChannel` + `markRead` used to sit BEFORE the STOP/START handling, automations,
 * flows and auto-replies. A channel token that cannot be decrypted (CHANNEL_ENCRYPTION_KEY
 * mismatch or rotation -> AES-256-GCM auth failure) or a transient credential-lookup error
 * therefore threw out of handleInbound after the message row was already recorded — and since the
 * replay guard skips an already-recorded message when the outbox redelivers it, the customer's
 * STOP (and every automation) was lost permanently.
 *
 * These tests drive the real handleInbound consumer through a fake bus and patch the shared
 * repository singletons the same way replay.test.js does; no Postgres/Redis is touched.
 */

const DECRYPT_FAILURE = "Unsupported state or unable to authenticate data";

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

const HEALTHY_CREDENTIALS = { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" };

/**
 * Wires the real worker consumers to recording stubs. `getCredentials` and `markRead` are the
 * two behaviours under test; everything else is a benign default for a brand-new contact whose
 * conversation is already assigned (so round-robin is skipped).
 */
function harness({ getCredentials, markRead = async () => {} }) {
  const calls = { revoke: [], setOptedOut: [], markRead: [], stopSequence: 0, autoReplyList: 0, newMessageRules: 0 };
  const bus = createFakeBus();
  const restores = [
    patch(messageRepository, { findByExternalId: async () => undefined, create: async () => ({ id: "msg-1" }) }),
    patch(contactRepository, {
      findOrCreateByPhone: async () => ({ id: "contact-1", phoneE164: "+15559998888" }),
      setOptedOut: async (...args) => {
        calls.setOptedOut.push(args);
      }
    }),
    patch(conversationRepository, {
      findOrCreate: async () => ({ id: "conv-1", assignedUserId: "user-1" }),
      touchInbound: async () => {}
    }),
    patch(consentRepository, {
      revoke: async (...args) => {
        calls.revoke.push(args);
      }
    }),
    patch(channelRepository, { getCredentials }),
    patch(whatsappSettingsRepository, { getByTenant: async () => undefined }),
    patch(sequenceRepository, {
      stopActiveForContact: async () => {
        calls.stopSequence++;
        return 0;
      }
    }),
    patch(automationSettingsRepository, { get: async () => undefined }),
    patch(flowRepository, {
      activeSessionForConversation: async () => undefined,
      findByTrigger: async () => undefined
    }),
    patch(autoReplyRuleRepository, {
      listEnabled: async () => {
        calls.autoReplyList++;
        return [];
      }
    }),
    patch(automationRuleRepository, {
      listEnabledByTrigger: async () => {
        calls.newMessageRules++;
        return [];
      }
    })
  ];
  const metaClient = {
    async send() {
      throw new Error("unexpected send");
    },
    async markRead(...args) {
      calls.markRead.push(args);
      return markRead(...args);
    },
    async fetchMedia() {
      throw new Error("unexpected fetchMedia");
    }
  };
  registerWorkerConsumers({
    eventBus: bus,
    metaClient,
    resolveChannel: async () => ({ tenantId: "t-1", channelId: "c-1" })
  });
  return {
    bus,
    calls,
    handleInbound: bus.handlers.get(EventTopics.WhatsAppInboundReceived),
    restore: () => restores.reverse().forEach((restore) => restore())
  };
}

function inboundEvent(overrides = {}) {
  return {
    id: "env-1",
    topic: EventTopics.WhatsAppInboundReceived,
    occurredAt: new Date().toISOString(),
    payload: {
      phoneNumberId: "PN-1",
      from: "+15559998888",
      messageId: "wamid.test-1",
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

function assertNotAborted(error) {
  assert.equal(
    error,
    undefined,
    `a failing best-effort read receipt must not abort inbound processing, but the handler threw: ${error?.message}`
  );
}

test("handleInbound: STOP is honoured even when the channel token cannot be decrypted", async () => {
  const h = harness({
    getCredentials: async () => {
      throw new Error(DECRYPT_FAILURE);
    }
  });
  try {
    const { error } = await deliver(h, { text: "STOP", messageId: "wamid.stop-1" });

    assertNotAborted(error);
    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]], "consent must be revoked");
    assert.deepEqual(h.calls.setOptedOut, [["t-1", "contact-1", true]], "contact must be marked opted out");
    assert.ok(
      h.bus.published.some((event) => event.topic === EventTopics.ComplianceOptOutEvent),
      "the compliance opt-out event must be published"
    );
  } finally {
    h.restore();
  }
});

test("handleInbound: a normal message still reaches sequences, auto-replies and rule automations when the channel token cannot be decrypted", async () => {
  const h = harness({
    getCredentials: async () => {
      throw new Error(DECRYPT_FAILURE);
    }
  });
  try {
    const { error } = await deliver(h, { text: "hello" });

    assertNotAborted(error);
    assert.equal(h.calls.stopSequence, 1, "stop-on-reply must run");
    assert.equal(h.calls.autoReplyList, 1, "auto-reply rules must be evaluated");
    assert.equal(h.calls.newMessageRules, 1, "new_message automation rules must be evaluated");
  } finally {
    h.restore();
  }
});

test("handleInbound: the swallowed credential failure is logged at error level with tenant, channel and cause", async () => {
  const h = harness({
    getCredentials: async () => {
      throw new Error(DECRYPT_FAILURE);
    }
  });
  try {
    const { logs } = await deliver(h, { text: "STOP", messageId: "wamid.stop-2" });

    const failure = logs.find((entry) => entry.message === "inbound_read_receipt_failed");
    assert.ok(failure, "the failure must not be swallowed silently");
    assert.equal(failure.level, "error");
    assert.equal(failure.tenantId, "t-1");
    assert.equal(failure.channelId, "c-1");
    assert.equal(failure.messageId, "wamid.stop-2");
    assert.match(failure.error, /unable to authenticate data/);
  } finally {
    h.restore();
  }
});

test("handleInbound: a throwing read-receipt transport does not block STOP handling", async () => {
  const h = harness({
    getCredentials: async () => HEALTHY_CREDENTIALS,
    markRead: async () => {
      throw new Error("mark_read_transport_exploded");
    }
  });
  try {
    const { error, logs } = await deliver(h, { text: "STOP", messageId: "wamid.stop-3" });

    assertNotAborted(error);
    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]]);
    const failure = logs.find((entry) => entry.message === "inbound_read_receipt_failed");
    assert.ok(failure, "the transport failure must be logged");
    assert.match(failure.error, /mark_read_transport_exploded/);
  } finally {
    h.restore();
  }
});

test("handleInbound: with healthy credentials the read receipt is still sent and nothing is logged as failed", async () => {
  const h = harness({ getCredentials: async () => HEALTHY_CREDENTIALS });
  try {
    const { error, logs } = await deliver(h, { text: "hello", messageId: "wamid.ok-1" });

    assertNotAborted(error);
    assert.deepEqual(h.calls.markRead, [["PN-1", "wamid.ok-1", "t-1", "tok"]]);
    assert.equal(
      logs.some((entry) => entry.message === "inbound_read_receipt_failed"),
      false
    );
  } finally {
    h.restore();
  }
});
