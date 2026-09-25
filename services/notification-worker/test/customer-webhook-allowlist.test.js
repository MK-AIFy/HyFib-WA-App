import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import dns from "node:dns";

// The allowlist is operator config (OUTBOUND_WEBHOOK_ALLOWLIST), read once by loadConfig when the worker module is
// evaluated — so it is set BEFORE the dynamic imports below. SAFETY: other projects' Redis and Postgres listen on
// this machine's default ports; point both at port 1, where nothing listens (nothing here connects anyway: every
// repository call is patched).
process.env.OUTBOUND_WEBHOOK_ALLOWLIST = "receiver.corp, 127.0.0.1";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";

const { registerWorkerConsumers } = await import("../dist/index.js");
const {
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
} = await import("@hyfib/persistence");
const { EventTopics, renderMetrics } = await import("@hyfib/shared-core");

/**
 * The customer webhook as the worker fires it (handleInbound, fire-and-forget) with an operator allowlist in the
 * environment: an on-prem receiver listed by host name AND address is delivered to through the real guarded
 * transport; anything else is still refused, and the customer_webhook_blocked line tells the operator whether an
 * allowlist entry could help — without the URL's path/query or the signing secret.
 */

const SECRET = "whsec_TOPSECRET_do_not_log";

function patch(target, impls) {
  const originals = {};
  for (const [key, impl] of Object.entries(impls)) {
    originals[key] = target[key];
    target[key] = impl;
  }
  return () => Object.assign(target, originals);
}

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
  return { entries, raw, restore: () => (process.stdout.write = original) };
}

function counterValue(result) {
  const series = `customer_webhooks_total{result="${result}"}`;
  const line = renderMetrics()
    .split("\n")
    .find((candidate) => candidate.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

async function settle(predicate) {
  for (let i = 0; i < 400 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function harness(settings) {
  const handlers = new Map();
  const bus = {
    subscribe: (topic, _queue, handler) => handlers.set(topic, handler),
    publish: async () => {},
    close: async () => {}
  };
  const restores = [
    patch(messageRepository, { findByExternalId: async () => undefined, create: async () => ({ id: "msg-1" }) }),
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
    handleInbound: handlers.get(EventTopics.WhatsAppInboundReceived),
    restore: () => restores.reverse().forEach((restore) => restore())
  };
}

let nextMessage = 0;

/** One inbound event through the real handler with `address` as every DNS answer; waits for the webhook outcome. */
async function runInbound(callbackUrl, address) {
  const h = harness({ statusCallbackUrl: callbackUrl, statusCallbackSecret: SECRET });
  const before = {
    delivered: counterValue("delivered"),
    blocked: counterValue("blocked"),
    failed: counterValue("failed")
  };
  const originalLookup = dns.promises.lookup;
  const lookups = [];
  dns.promises.lookup = async (hostname) => {
    lookups.push(hostname);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    throw new Error("global fetch must not be used for customer webhooks");
  };
  const logs = captureLogs();
  let error;
  try {
    nextMessage += 1;
    await h.handleInbound({
      id: `env-allowlist-${nextMessage}`,
      topic: EventTopics.WhatsAppInboundReceived,
      occurredAt: new Date().toISOString(),
      payload: {
        phoneNumberId: "PN-1",
        from: "+15559998888",
        messageId: `wamid.allowlist-${nextMessage}`,
        type: "text",
        text: "hello"
      }
    });
    await settle(
      () =>
        counterValue("delivered") > before.delivered ||
        counterValue("blocked") > before.blocked ||
        counterValue("failed") > before.failed
    );
  } catch (caught) {
    error = caught;
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
    dns.promises.lookup = originalLookup;
    h.restore();
  }
  return {
    error,
    lookups,
    globalFetchCalls,
    logs: logs.entries,
    raw: logs.raw.join(""),
    delivered: counterValue("delivered") - before.delivered,
    blocked: counterValue("blocked") - before.blocked,
    failed: counterValue("failed") - before.failed
  };
}

async function startReceiver() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function blockedEntry(outcome) {
  const entry = outcome.logs.find((log) => log.message === "customer_webhook_blocked");
  assert.ok(entry, "a customer_webhook_blocked line must be logged");
  assert.equal(entry.level, "warn");
  return entry;
}

function assertNothingLeaked(outcome) {
  assert.doesNotMatch(outcome.raw, /whsec_TOPSECRET/, "the signing secret must never be logged");
  assert.doesNotMatch(outcome.raw, /token=abc123|\/private\/path/, "the URL path/query must not be logged");
}

test("an allowlisted on-prem receiver (host AND address listed) is delivered to through the guarded transport", async () => {
  const receiver = await startReceiver();
  try {
    const outcome = await runInbound(`http://receiver.corp:${receiver.port}/private/path?token=abc123`, "127.0.0.1");

    assert.equal(outcome.error, undefined);
    assert.equal(outcome.delivered, 1, JSON.stringify(outcome.logs.filter((l) => l.message?.startsWith("customer"))));
    assert.equal(outcome.blocked, 0);
    assert.equal(outcome.globalFetchCalls, 0);
    assert.deepEqual(outcome.lookups, ["receiver.corp"], "resolved once, and only the vetted address was used");
    assert.equal(receiver.requests.length, 1);
    assert.equal(receiver.requests[0].url, "/private/path?token=abc123");
    assert.equal(
      outcome.logs.some((log) => String(log.message).startsWith("customer_webhook_")),
      false,
      "a delivered webhook logs nothing"
    );
  } finally {
    await receiver.close();
  }
});

test("an internal name that is not allowlisted is still refused, with a hint to allowlist the host name", async () => {
  const receiver = await startReceiver();
  try {
    const outcome = await runInbound(`http://other.corp:${receiver.port}/private/path?token=abc123`, "127.0.0.1");
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.blocked, 1);
    assert.equal(outcome.delivered, 0);
    assert.deepEqual(outcome.lookups, [], "refused by the name check before any resolution");
    assert.equal(receiver.requests.length, 0);

    const entry = blockedEntry(outcome);
    assert.equal(entry.host, `other.corp:${receiver.port}`);
    assert.match(entry.reason, /internal name/);
    assert.match(entry.hint, /OUTBOUND_WEBHOOK_ALLOWLIST/);
    assert.match(entry.hint, /host name/);
    assertNothingLeaked(outcome);
  } finally {
    await receiver.close();
  }
});

test("an allowlisted host name that resolves outside the allowlisted addresses is refused at connect time", async () => {
  const outcome = await runInbound("http://receiver.corp:8443/private/path?token=abc123", "10.20.30.40");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.blocked, 1);
  assert.deepEqual(outcome.lookups, ["receiver.corp"]);

  const entry = blockedEntry(outcome);
  assert.equal(entry.host, "receiver.corp:8443");
  assert.match(entry.reason, /10\.20\.30\.40/);
  assert.match(entry.hint, /OUTBOUND_WEBHOOK_ALLOWLIST/);
  assert.match(entry.hint, /exact address/);
  assertNothingLeaked(outcome);
});

test("the hard floor stays refused for an allowlisted host name, and the hint says it cannot be allowlisted", async () => {
  const outcome = await runInbound("http://receiver.corp/private/path?token=abc123", "169.254.169.254");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.blocked, 1);

  const entry = blockedEntry(outcome);
  assert.match(entry.reason, /169\.254\.169\.254/);
  assert.match(entry.hint, /cannot be allowlisted/);
  assertNothingLeaked(outcome);
});
