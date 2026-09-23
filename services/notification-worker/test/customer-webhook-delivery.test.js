import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
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
 * The customer webhook (status_callback_url) as the worker actually fires it: from handleInbound, after the
 * message row is written, fire-and-forget. A stored URL that points inside the network — saved before
 * save-time validation existed, or resolving there later — must be refused, logged without the signing
 * secret or the URL's path/query, counted as "blocked", and must never fail the inbound handler.
 * Repository singletons are patched as in inbound-opt-out.test.js; no Postgres, Redis or network is touched.
 */

const SECRET = "whsec_TOPSECRET_do_not_log";

function createFakeBus() {
  const handlers = new Map();
  return {
    handlers,
    subscribe(topic, _queue, handler) {
      handlers.set(topic, handler);
    },
    async publish() {},
    async close() {}
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

/**
 * Collects the text the shared logger writes to stdout (it writes JSON strings). Binary chunks pass through:
 * the test runner streams its own serialized results over the same stdout, and settle() yields to the event
 * loop while this capture is active.
 */
function captureLogs() {
  const entries = [];
  const raw = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== "string") {
      return original(chunk, ...rest);
    }
    raw.push(chunk);
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
    raw,
    restore: () => {
      process.stdout.write = original;
    }
  };
}

function counterValue(name, labels) {
  const series = `${name}{${labels}}`;
  const line = renderMetrics()
    .split("\n")
    .find((candidate) => candidate.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

const blockedCount = () => counterValue("customer_webhooks_total", 'result="blocked"');
const failedCount = () => counterValue("customer_webhooks_total", 'result="failed"');

/** The webhook is fire-and-forget; wait (bounded) until its outcome has been counted. */
async function settle(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function harness(settings) {
  let created = 0;
  const bus = createFakeBus();
  const restores = [
    patch(messageRepository, {
      findByExternalId: async () => undefined,
      create: async () => {
        created += 1;
        return { id: "msg-1" };
      }
    }),
    patch(contactRepository, {
      findOrCreateByPhone: async () => ({ id: "contact-1", phoneE164: "+15559998888" }),
      setOptedOut: async () => {}
    }),
    patch(conversationRepository, {
      findOrCreate: async () => ({ id: "conv-1", assignedUserId: "user-1" }),
      touchInbound: async () => {}
    }),
    patch(consentRepository, { revoke: async () => {}, grant: async () => {} }),
    patch(channelRepository, {
      getCredentials: async () => ({ id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" })
    }),
    patch(whatsappSettingsRepository, { getByTenant: async () => settings }),
    patch(sequenceRepository, { stopActiveForContact: async () => 0 }),
    patch(automationSettingsRepository, { get: async () => undefined }),
    patch(flowRepository, {
      activeSessionForConversation: async () => undefined,
      findByTrigger: async () => undefined
    }),
    patch(autoReplyRuleRepository, { listEnabled: async () => [] }),
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
    enqueueMediaFetch: async () => {}
  });
  return {
    handleInbound: bus.handlers.get(EventTopics.WhatsAppInboundReceived),
    created: () => created,
    restore: () => restores.reverse().forEach((restore) => restore())
  };
}

let nextMessage = 0;

function inboundEvent() {
  return {
    id: `env-${(nextMessage += 1)}`,
    topic: EventTopics.WhatsAppInboundReceived,
    occurredAt: new Date().toISOString(),
    payload: {
      phoneNumberId: "PN-1",
      from: "+15559998888",
      messageId: `wamid.webhook-guard-${nextMessage}`,
      type: "text",
      text: "hello"
    }
  };
}

/** Runs one inbound event through the real handler and waits for the fire-and-forget webhook to settle. */
async function runInbound(settings) {
  const h = harness(settings);
  const blockedBefore = blockedCount();
  const failedBefore = failedCount();
  // Tripwire: the webhook must never fall back to the global (redirect-following, unguarded) fetch.
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch must not be used for customer webhooks");
  };
  const logs = captureLogs();
  let error;
  try {
    await h.handleInbound(inboundEvent());
    await settle(() => blockedCount() > blockedBefore || failedCount() > failedBefore);
  } catch (caught) {
    error = caught;
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
    h.restore();
  }
  return {
    error,
    globalFetchCalls,
    created: h.created(),
    logs: logs.entries,
    raw: logs.raw.join(""),
    blocked: blockedCount() - blockedBefore,
    failed: failedCount() - failedBefore
  };
}

test("handleInbound: a stored metadata-IP callback URL is refused, logged without secret or path, and counted", async () => {
  const outcome = await runInbound({
    statusCallbackUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/?token=abc123",
    statusCallbackSecret: SECRET
  });

  assert.equal(outcome.error, undefined, "a refused webhook must never fail the inbound handler");
  assert.equal(outcome.created, 1, "the inbound message is still recorded");
  assert.equal(outcome.blocked, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.globalFetchCalls, 0);

  const entry = outcome.logs.find((log) => log.message === "customer_webhook_blocked");
  assert.ok(entry, "a customer_webhook_blocked line must be logged");
  assert.equal(entry.level, "warn");
  assert.equal(entry.tenantId, "t-1");
  assert.equal(entry.type, "message.inbound");
  assert.equal(entry.host, "169.254.169.254");
  assert.match(entry.reason, /private|reserved/);

  assert.doesNotMatch(outcome.raw, /whsec_TOPSECRET/, "the signing secret must never be logged");
  assert.doesNotMatch(outcome.raw, /security-credentials|token=abc123/, "the URL path/query must not be logged");
});

test("handleInbound: a stored callback host that resolves to a private address is refused at delivery time", async () => {
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: "10.20.30.40", family: 4 }];
  let outcome;
  try {
    outcome = await runInbound({
      statusCallbackUrl: "https://hooks.tenant-controlled.example/cb",
      statusCallbackSecret: SECRET
    });
  } finally {
    dns.promises.lookup = original;
  }

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.blocked, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.globalFetchCalls, 0);
  const entry = outcome.logs.find((log) => log.message === "customer_webhook_blocked");
  assert.ok(entry);
  assert.equal(entry.host, "hooks.tenant-controlled.example");
  assert.match(entry.reason, /10\.20\.30\.40/);
  assert.doesNotMatch(outcome.raw, /whsec_TOPSECRET/);
});

test("handleInbound: no callback configured still means no delivery and nothing counted", async () => {
  const outcome = await runInbound(undefined);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.blocked, 0);
  assert.equal(outcome.failed, 0);
  assert.equal(
    outcome.logs.some((log) => String(log.message).startsWith("customer_webhook")),
    false
  );
});
