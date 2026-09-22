import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createGatewayHandler } from "../dist/index.js";

/**
 * Ordering of the inbound webhook route's idempotency claim, driven through the real HTTP handler with the
 * Redis store and the channel resolver injected; no Redis or Postgres is touched.
 *
 * Meta retries a failed delivery with the SAME x-hub-signature-256, which is what the claim is keyed on. So
 * every check that can reject or fail a delivery has to run BEFORE the claim: a key left behind on one of
 * those paths survives 24h and silently swallows the retry, losing the messages in that delivery for good.
 */

// Mirrors loadConfig: META_APP_SECRET is optional outside production and resolves to "".
const APP_SECRET = process.env.META_APP_SECRET ?? "";

const PHONE_NUMBER_ID = "PN-1";

function webhookBody(phoneNumberId = PHONE_NUMBER_ID) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: "wamid.1", from: "15559998888", type: "text", text: { body: "hi" } }]
            }
          }
        ]
      }
    ]
  });
}

function sign(rawBody) {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
}

/** An in-memory stand-in for RedisIdempotencyStore with the same claim-on-check semantics (SET NX). */
function fakeIdempotencyStore() {
  const claimed = new Set();
  const calls = { isDuplicate: 0, release: 0 };
  return {
    claimed,
    calls,
    async isDuplicate(key) {
      calls.isDuplicate += 1;
      if (claimed.has(key)) {
        return true;
      }
      claimed.add(key);
      return false;
    },
    async release(key) {
      calls.release += 1;
      claimed.delete(key);
    }
  };
}

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

/**
 * Boots the real gateway on an ephemeral port with the webhook dependencies injected. `resolveWebhookChannel`
 * and the proxy are functions so a test can make them fail and then recover, the way a DB outage does.
 */
async function boot({ resolveWebhookChannel = async () => ({ tenantId: "t-1", channelId: "c-1" }), proxy } = {}) {
  const store = fakeIdempotencyStore();
  const deliveries = [];
  const gateway = createGatewayHandler({
    eventBus: stubBus,
    webhookIdempotencyStore: store,
    resolveWebhookChannel,
    proxyWebhookToIngestor: async (forwarded) => {
      deliveries.push(forwarded);
      return proxy ? proxy(forwarded) : { ok: true, body: { status: "accepted" }, status: 200 };
    }
  });
  const server = createServer((req, res) => {
    gateway.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store,
    deliveries,
    base,
    post: (rawBody) =>
      fetch(`${base}/api/v1/webhooks/meta/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hub-signature-256": sign(rawBody) },
        body: rawBody
      }),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("webhook: a delivery for an unresolvable phone_number_id leaves no claim, so Meta's retry is processed", async () => {
  // The resolver caches its negative result, so a channel that is a moment from existing (just created, or a
  // read replica lagging) can answer "unknown" once. That must not cost the delivery.
  let known = false;
  const h = await boot({
    resolveWebhookChannel: async () => (known ? { tenantId: "t-1", channelId: "c-1" } : undefined)
  });
  const rawBody = webhookBody();
  try {
    const first = await h.post(rawBody);
    assert.equal(first.status, 200, "Meta must always get a 200 here");
    assert.deepEqual(await first.json(), { status: "channel_not_found" });
    assert.equal(h.store.claimed.size, 0, "a rejected delivery must not leave an idempotency claim behind");
    assert.equal(h.deliveries.length, 0, "and must not reach the ingestor");

    known = true;
    const retry = await h.post(rawBody);
    assert.equal(retry.status, 200);
    assert.equal(h.deliveries.length, 1, "the retry of the same delivery must be processed, not swallowed");
  } finally {
    await h.close();
  }
});

test("webhook: a channel-resolution outage answers 502 and leaves no claim, so the retry is processed", async () => {
  // Worst case before the reorder: the throw escaped the route's release entirely, so the key sat claimed for
  // 24h and every retry of the delivery returned duplicate_ignored — the messages were lost.
  let down = true;
  const h = await boot({
    resolveWebhookChannel: async () => {
      if (down) {
        throw new Error("connection terminated unexpectedly");
      }
      return { tenantId: "t-1", channelId: "c-1" };
    }
  });
  const rawBody = webhookBody();
  try {
    const first = await h.post(rawBody);
    assert.equal(first.status, 502, "a database outage is not a rejected delivery; Meta must be told to retry");
    assert.equal(h.store.claimed.size, 0, "the outage must not leave an idempotency claim behind");

    down = false;
    const retry = await h.post(rawBody);
    assert.equal(retry.status, 200);
    assert.equal(h.deliveries.length, 1, "the retry must be processed, not swallowed as a duplicate");
  } finally {
    await h.close();
  }
});

test("webhook: a genuine redelivery of an accepted webhook is still ignored as a duplicate", async () => {
  const h = await boot();
  const rawBody = webhookBody();
  try {
    const first = await h.post(rawBody);
    assert.equal(first.status, 200);
    assert.equal(h.store.claimed.size, 1, "an accepted delivery must hold its claim");

    const second = await h.post(rawBody);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { status: "duplicate_ignored" });
    assert.equal(h.deliveries.length, 1, "the ingestor must see the delivery exactly once");
  } finally {
    await h.close();
  }
});

test("webhook: two different deliveries are both processed", async () => {
  const h = await boot();
  try {
    const first = await h.post(webhookBody());
    const second = await h.post(JSON.stringify({ ...JSON.parse(webhookBody()), object: "second" }));

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(h.deliveries.length, 2, "distinct signatures are distinct claims");
  } finally {
    await h.close();
  }
});

test("webhook: an ingestor processing failure still releases the claim so the retry is processed", async () => {
  let failing = true;
  const h = await boot({
    proxy: async () =>
      failing ? { ok: false, body: { status: "error" }, status: 503 } : { ok: true, body: {}, status: 200 }
  });
  const rawBody = webhookBody();
  try {
    const first = await h.post(rawBody);
    assert.equal(first.status, 502);
    assert.equal(h.store.claimed.size, 0, "the failed delivery's claim must be released");

    failing = false;
    const retry = await h.post(rawBody);
    assert.equal(retry.status, 200);
    assert.equal(h.deliveries.length, 2, "the retry must reach the ingestor");
  } finally {
    await h.close();
  }
});

test("webhook: a body with no phone_number_id is claimed and forwarded unchanged", async () => {
  // Status callbacks and non-JSON bodies skip the channel check; they must still dedupe as before.
  const h = await boot({
    resolveWebhookChannel: async () => {
      throw new Error("resolver must not be called when there is no phone_number_id");
    }
  });
  const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  try {
    const first = await h.post(rawBody);
    assert.equal(first.status, 200);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.store.claimed.size, 1);

    const second = await h.post(rawBody);
    assert.deepEqual(await second.json(), { status: "duplicate_ignored" });
  } finally {
    await h.close();
  }
});

test("webhook: an invalid signature is rejected before any claim is taken", async () => {
  const h = await boot();
  const rawBody = webhookBody();
  try {
    const res = await fetch(`${h.base}/api/v1/webhooks/meta/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: rawBody
    });

    assert.equal(res.status, 401);
    assert.equal(h.store.calls.isDuplicate, 0, "an unauthenticated body must never touch the idempotency store");
  } finally {
    await h.close();
  }
});
