import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import {
  autoReplyRuleRepository,
  consentRepository,
  contactRepository,
  conversationRepository,
  messageRepository
} from "@hyfib/persistence";
import { EventTopics, renderMetrics } from "@hyfib/shared-core";

/**
 * How handleSocialInbound applies a Messenger/Instagram STOP/START, driven through the real consumer with the shared
 * repository singletons patched (the technique inbound-opt-out.test.js uses for the WhatsApp path); no Postgres or
 * Redis is touched.
 *
 * A STOP typed on Messenger or Instagram used to be stored as an ordinary message: consent stayed granted, the
 * contact was never opted out, and a keyword auto-reply could still answer the STOP. The message row is the replay
 * guard's marker here too, so the opt-out must be applied before that row is written, exactly as handleInbound does.
 * The fake findByExternalId mirrors that: a row is findable as soon as create has committed it.
 */

function createFakeBus({ publishFailures = 0 } = {}) {
  const handlers = new Map();
  const published = [];
  const failPublish = failFirst(publishFailures, "publish_failed");
  return {
    handlers,
    published,
    subscribe(topic, _queue, handler) {
      handlers.set(topic, handler);
    },
    async publish(topic, payload, tenantId) {
      failPublish();
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
 * Wires the real worker consumers to recording stubs for a Messenger/Instagram contact. `steps` records the order of
 * the side effects the replay guard cares about; the failure knobs make one transient step throw a fixed number of
 * times. Auto-reply rules are empty, so reaching `listEnabled` is how a test sees the auto-reply being evaluated
 * (a matching rule would enqueue through withTenant, which needs Postgres).
 */
function harness({ setOptedOutFailures = 0, publishFailures = 0 } = {}) {
  const steps = [];
  const recorded = new Set();
  const state = { optedOut: false };
  const calls = { contactPhones: [], revoke: [], grant: [], setOptedOut: [], messages: [], autoReplyList: 0 };
  const failSetOptedOut = failFirst(setOptedOutFailures, "set_opted_out_failed");
  const bus = createFakeBus({ publishFailures });
  const restores = [
    patch(messageRepository, {
      findByExternalId: async (_tenantId, externalId) =>
        recorded.has(externalId) ? { id: "msg-1", conversationId: "conv-1", payload: {} } : undefined,
      create: async (_tenantId, input) => {
        steps.push("message.create");
        calls.messages.push(input);
        recorded.add(input.externalMessageId);
        return { id: "msg-1" };
      }
    }),
    patch(contactRepository, {
      findOrCreateByPhone: async (_tenantId, phone) => {
        calls.contactPhones.push(phone);
        return { id: "contact-1", phoneE164: phone };
      },
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
    patch(autoReplyRuleRepository, {
      listEnabled: async () => {
        calls.autoReplyList += 1;
        return [];
      }
    })
  ];
  registerWorkerConsumers({
    eventBus: bus,
    metaClient: {
      async send() {
        throw new Error("unexpected send");
      },
      async markRead() {
        throw new Error("unexpected markRead");
      },
      async fetchMedia() {
        throw new Error("unexpected fetchMedia");
      }
    },
    resolveChannel: async () => ({ tenantId: "t-1", channelId: "c-social" }),
    enqueueMediaFetch: async () => {
      throw new Error("unexpected enqueueMediaFetch");
    }
  });
  return {
    bus,
    calls,
    steps,
    state,
    handleSocialInbound: bus.handlers.get(EventTopics.SocialInboundReceived),
    restore: () => restores.reverse().forEach((restore) => restore())
  };
}

let nextMessage = 0;

function socialEvent(overrides = {}) {
  return {
    id: "env-social-1",
    topic: EventTopics.SocialInboundReceived,
    occurredAt: new Date().toISOString(),
    payload: {
      channelType: "messenger",
      pageId: "PAGE-1",
      senderId: "PSID-1",
      messageId: `m_auto-${(nextMessage += 1)}`,
      text: "hello",
      timestamp: new Date().toISOString(),
      ...overrides
    }
  };
}

/** Delivers one social inbound event; returns whatever the handler threw (if anything) plus its log lines. */
async function deliver(h, overrides) {
  const logs = captureLogs();
  let error;
  try {
    await h.handleSocialInbound(socialEvent(overrides));
  } catch (caught) {
    error = caught;
  } finally {
    logs.restore();
  }
  return { error, logs: logs.entries };
}

const isOptOutEvent = (event) => event.topic === EventTopics.ComplianceOptOutEvent;

for (const [channelType, channelName] of [
  ["messenger", "Messenger"],
  ["instagram", "Instagram"]
]) {
  test(`handleSocialInbound: a STOP on ${channelName} is applied before the message row (the replay marker) is written`, async () => {
    const h = harness();
    const labels = `channel="${channelType}",source="inbound_stop"`;
    const before = counterValue("contact_opt_outs_total", labels);
    try {
      const { error, logs } = await deliver(h, { channelType, text: "STOP", senderId: `PSID-${channelType}` });

      assert.equal(error, undefined);
      assert.deepEqual(h.calls.contactPhones, [`psid:PSID-${channelType}`]);
      assert.deepEqual(h.steps, ["revoke", "setOptedOut:true", "message.create"]);
      assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]]);
      assert.equal(h.state.optedOut, true);
      assert.deepEqual(
        h.bus.published.filter(isOptOutEvent),
        [
          {
            topic: EventTopics.ComplianceOptOutEvent,
            payload: {
              tenantId: "t-1",
              contactId: "contact-1",
              phoneE164: `psid:PSID-${channelType}`,
              reason: "inbound_stop"
            },
            tenantId: "t-1"
          }
        ],
        "the compliance opt-out event must be published once"
      );
      assert.equal(h.calls.autoReplyList, 0, "no auto-reply after a STOP");
      assert.equal(counterValue("contact_opt_outs_total", labels), before + 1);
      const entry = logs.find((line) => line.message === "inbound_opt_out");
      assert.ok(entry, "the opt-out must be logged");
      assert.equal(entry.tenantId, "t-1");
      assert.equal(entry.contactId, "contact-1");
      assert.equal(entry.channelType, channelType);
    } finally {
      h.restore();
    }
  });
}

test("handleSocialInbound: a social STOP does not count toward the WhatsApp opt-out series", async () => {
  // The WhatsApp series keeps its exact label set; social opt-outs are a separate series with a channel label, so
  // sum(contact_opt_outs_total) still counts both while no existing series changes shape.
  const h = harness();
  const whatsapp = counterValue("contact_opt_outs_total", 'source="inbound_stop"');
  try {
    const { error } = await deliver(h, { text: "STOP" });

    assert.equal(error, undefined);
    assert.equal(counterValue("contact_opt_outs_total", 'source="inbound_stop"'), whatsapp);
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: a half-applied STOP is retried, not skipped as a replay", async () => {
  const h = harness({ setOptedOutFailures: 1 });
  const stop = { text: "STOP", messageId: "m_stop-half" };
  try {
    const first = await deliver(h, stop);
    assert.match(first.error?.message ?? "", /set_opted_out_failed/);
    assert.equal(
      h.calls.messages.length,
      0,
      "no message row may exist yet: it would make the redelivery look like an already-handled replay"
    );

    const second = await deliver(h, stop);
    assert.equal(second.error, undefined);
    assert.equal(h.state.optedOut, true, "the redelivery must finish the opt-out");
    assert.equal(h.calls.messages.length, 1, "and record the message once");
    assert.equal(h.bus.published.filter(isOptOutEvent).length, 1);
    assert.equal(h.calls.autoReplyList, 0, "no auto-reply after a STOP, on the redelivery either");
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: a STOP is not lost when a step after the message row is written throws", async () => {
  // Publishing the compliance event runs after the row is committed and fails transiently.
  const h = harness({ publishFailures: 1 });
  const stop = { channelType: "instagram", text: "STOP", messageId: "m_stop-publish" };
  try {
    const first = await deliver(h, stop);
    assert.match(first.error?.message ?? "", /publish_failed/, "the failure must still fail the delivery");

    // The outbox redelivers; the replay guard now finds the committed row and skips the handler.
    const second = await deliver(h, stop);
    assert.equal(second.error, undefined);

    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]], "consent must be revoked exactly once");
    assert.equal(h.state.optedOut, true, "the contact must end up opted out");
    assert.equal(h.calls.autoReplyList, 0);
  } finally {
    h.restore();
  }
});

/*
 * A social START only lifts the opted-out flag. consentRepository.grant writes a consent_records row with
 * channel='whatsapp', and any un-revoked consent row puts the contact into WhatsApp campaign audiences; a psid:
 * contact has no WhatsApp number, so every such send would fail, and the ledger would record a WhatsApp consent the
 * customer never gave. WhatsApp marketing consent must not be inferred from a Messenger/Instagram message.
 */
for (const [channelType, channelName] of [
  ["messenger", "Messenger"],
  ["instagram", "Instagram"]
]) {
  test(`handleSocialInbound: START on ${channelName} lifts the opt-out after the message row without granting WhatsApp consent`, async () => {
    const h = harness();
    const labels = `channel="${channelType}",source="inbound_start"`;
    const before = counterValue("contact_opt_ins_total", labels);
    try {
      const { error, logs } = await deliver(h, { channelType, text: "START", senderId: `PSID-${channelType}` });

      assert.equal(error, undefined);
      assert.deepEqual(h.calls.grant, [], "a social START must not write a (WhatsApp-scoped) consent record");
      assert.deepEqual(h.steps, ["message.create", "setOptedOut:false"], "START stays after the replay marker");
      assert.deepEqual(h.calls.setOptedOut, [["t-1", "contact-1", false]]);
      assert.deepEqual(h.calls.revoke, []);
      assert.equal(h.bus.published.some(isOptOutEvent), false);
      assert.equal(h.calls.autoReplyList, 1, "the START carries on to auto-reply evaluation");
      assert.equal(counterValue("contact_opt_ins_total", labels), before + 1);
      const entry = logs.find((line) => line.message === "inbound_opt_in");
      assert.ok(entry, "the opt-in must be logged");
      assert.equal(entry.tenantId, "t-1");
      assert.equal(entry.contactId, "contact-1");
      assert.equal(entry.channelType, channelType);
    } finally {
      h.restore();
    }
  });
}

test("handleSocialInbound: a START after a STOP undoes the opt-out and still grants no consent", async () => {
  const h = harness();
  try {
    const stop = await deliver(h, { channelType: "instagram", text: "STOP" });
    assert.equal(stop.error, undefined);
    assert.equal(h.state.optedOut, true);

    const start = await deliver(h, { channelType: "instagram", text: "START" });
    assert.equal(start.error, undefined);

    assert.equal(h.state.optedOut, false, "the START must lift the opt-out the STOP set");
    assert.deepEqual(h.steps, ["revoke", "setOptedOut:true", "message.create", "message.create", "setOptedOut:false"]);
    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]]);
    assert.deepEqual(h.calls.grant, [], "the revoked consent must not be re-granted by a social START");
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: ordinary text changes no consent and still reaches auto-reply evaluation", async () => {
  const h = harness();
  try {
    const { error } = await deliver(h, { text: "what are your prices?" });

    assert.equal(error, undefined);
    assert.deepEqual(h.steps, ["message.create"]);
    assert.deepEqual(h.calls.revoke, []);
    assert.deepEqual(h.calls.grant, []);
    assert.deepEqual(h.calls.setOptedOut, []);
    assert.equal(h.bus.published.some(isOptOutEvent), false);
    assert.equal(h.calls.autoReplyList, 1);
    assert.deepEqual(h.calls.messages[0].payload, {
      type: "text",
      text: "what are your prices?",
      channelType: "messenger",
      timestamp: h.calls.messages[0].payload.timestamp
    });
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: an ordinary sentence containing an opt-out word does not opt the customer out", async () => {
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

test("handleSocialInbound: social text is the customer's own typing, so a bare 'cancel' opts them out", async () => {
  // Messenger/Instagram inbound carries only the typed message text (no button or list-reply payload), so it is
  // matched as "typed": the everyday words count when they are the whole message, as for typed WhatsApp text.
  const h = harness();
  try {
    const { error } = await deliver(h, { channelType: "instagram", text: "cancel" });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, [["t-1", "contact-1", "inbound_stop"]]);
    assert.equal(h.state.optedOut, true);
    assert.equal(h.calls.autoReplyList, 0);
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: a message without text is recorded without touching consent", async () => {
  // An attachment-only message (a photo, a sticker) arrives with no text.
  const h = harness();
  try {
    const { error } = await deliver(h, { text: undefined });

    assert.equal(error, undefined);
    assert.deepEqual(h.steps, ["message.create"]);
    assert.equal(h.calls.autoReplyList, 0, "there is nothing to match an auto-reply against");
  } finally {
    h.restore();
  }
});

test("handleSocialInbound: stop-like text that is not honoured is logged and counted, without the message text", async () => {
  const h = harness();
  const labels = 'channel="instagram",type="text"';
  const before = counterValue("inbound_possible_opt_outs_total", labels);
  try {
    const { error, logs } = await deliver(h, {
      channelType: "instagram",
      text: "Stop, wrong number",
      messageId: "m_possible-1"
    });

    assert.equal(error, undefined);
    assert.deepEqual(h.calls.revoke, [], "it is deliberately not treated as an opt-out");
    const entry = logs.find((line) => line.message === "inbound_possible_opt_out");
    assert.ok(entry, "the declined stop-like message must be visible to operators");
    assert.equal(entry.level, "info");
    assert.equal(entry.tenantId, "t-1");
    assert.equal(entry.contactId, "contact-1");
    assert.equal(entry.messageId, "m_possible-1");
    assert.equal(entry.type, "text");
    assert.equal(entry.channelType, "instagram");
    assert.ok(!JSON.stringify(entry).includes("wrong number"), "the customer's text must not be logged");
    assert.equal(counterValue("inbound_possible_opt_outs_total", labels), before + 1);
    assert.equal(h.calls.autoReplyList, 1);
  } finally {
    h.restore();
  }
});
