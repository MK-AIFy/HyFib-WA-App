import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import dns from "node:dns";
import { createOutboundFetch } from "@hyfib/shared-core";
import { signWebhookBody, deliverCustomerWebhook } from "../dist/customer-webhook.js";

test("signWebhookBody produces sha256=<hmac> over the exact body", () => {
  const body = '{"type":"message.status"}';
  const expected = `sha256=${createHmac("sha256", "whsec_1").update(body).digest("hex")}`;
  assert.equal(signWebhookBody("whsec_1", body), expected);
});

test("delivery POSTs the signed event and reports ok", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const event = { type: "message.status", occurredAt: "2026-07-29T00:00:00.000Z", data: { status: "delivered" } };
  const result = await deliverCustomerWebhook({ url: "https://cb.example.com/h", secret: "whsec_1" }, event, fetchImpl);

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cb.example.com/h");
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.type, "message.status");
  assert.equal(calls[0].init.headers["x-hyfib-signature"], signWebhookBody("whsec_1", calls[0].init.body));
});

test("no secret → no signature header; network errors report ok:false without throwing", async () => {
  let headers;
  const okFetch = async (_url, init) => {
    headers = init.headers;
    return { ok: true, status: 204 };
  };
  await deliverCustomerWebhook(
    { url: "https://cb.example.com/h" },
    { type: "message.inbound", occurredAt: "x", data: {} },
    okFetch
  );
  assert.equal("x-hyfib-signature" in headers, false);

  const result = await deliverCustomerWebhook(
    { url: "https://cb.example.com/h", secret: "s" },
    { type: "message.inbound", occurredAt: "x", data: {} },
    async () => {
      throw new Error("ECONNREFUSED");
    }
  );
  assert.deepEqual(result, { ok: false });
});

// ─── Outbound-URL guard at delivery time (SSRF) ─────────────────────────────
//
// The stored status_callback_url is re-checked on every delivery: URLs saved before save-time validation
// existed are never re-validated anywhere else, so this is the protection that actually holds.

const EVENT = { type: "message.status", occurredAt: "2026-09-23T00:00:00.000Z", data: { status: "delivered" } };

const BLOCKED_DESTINATIONS = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://2852039166/latest/meta-data/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://127.0.0.1:15672/api/overview",
  "http://2130706433:5432/",
  "http://[::1]:8080/",
  "http://10.0.0.5/admin",
  "http://192.168.1.1/",
  "http://localhost:8080/internal/v1/whatsapp/send",
  "http://rabbitmq:15672/",
  "file:///etc/passwd",
  "gopher://example.com:70/_x",
  "https://user:pass@hooks.example.com/"
];

for (const url of BLOCKED_DESTINATIONS) {
  test(`delivery refuses ${url} without calling the transport or leaking the secret`, async () => {
    const calls = [];
    const fetchImpl = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200 };
    };
    const result = await deliverCustomerWebhook({ url, secret: "whsec_TOPSECRET" }, EVENT, fetchImpl);

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(typeof result.error, "string");
    assert.equal(calls.length, 0, "a refused destination must never reach the transport");
    assert.doesNotMatch(JSON.stringify(result), /whsec_TOPSECRET/);
  });
}

/** Substitutes the OS resolver for one test; the default transport reads it at call time. */
function stubResolver(address, family = 4) {
  const original = dns.promises.lookup;
  const calls = [];
  dns.promises.lookup = async (hostname) => {
    calls.push(hostname);
    return [{ address, family }];
  };
  return { calls, restore: () => (dns.promises.lookup = original) };
}

/** Fails the test if anything falls back to the global (redirect-following, unguarded) fetch. */
function forbidGlobalFetch() {
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async () => {
    used += 1;
    throw new Error("global fetch must not be used for customer webhooks");
  };
  return { used: () => used, restore: () => (globalThis.fetch = original) };
}

for (const [address, family] of [
  ["10.0.0.7", 4],
  ["169.254.169.254", 4],
  ["127.0.0.1", 4],
  ["fd00::7", 6]
]) {
  test(`the default transport blocks a public-looking host that resolves to ${address}`, async () => {
    const resolver = stubResolver(address, family);
    const globalFetch = forbidGlobalFetch();
    try {
      const result = await deliverCustomerWebhook(
        { url: "https://hooks.rebind-attacker.example/cb", secret: "whsec_TOPSECRET" },
        EVENT
      );
      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.ok(result.error.includes(address), result.error);
      assert.deepEqual(resolver.calls, ["hooks.rebind-attacker.example"]);
      assert.equal(globalFetch.used(), 0);
      assert.doesNotMatch(JSON.stringify(result), /whsec_TOPSECRET/);
    } finally {
      resolver.restore();
      globalFetch.restore();
    }
  });
}

/**
 * A loopback receiver reached through the real guarded transport. The guard refuses 127.0.0.1, so these
 * cases inject a resolver that maps the public-looking test host to loopback and a classifier that admits
 * loopback only; everything else (node:http, the lookup hook, the redirect policy) is the production path.
 */
async function startReceiver(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: (path) => `http://receiver.customer.example:${server.address().port}${path}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

const loopbackTransport = () =>
  createOutboundFetch({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isBlockedAddress: (ip) => ip !== "127.0.0.1"
  });

test("a public destination still receives the POST with the same headers and a verifiable signature", async () => {
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 200;
    res.end("thanks");
  });
  try {
    const result = await deliverCustomerWebhook(
      { url: receiver.url("/hooks/hyfib"), secret: "whsec_1" },
      EVENT,
      loopbackTransport()
    );

    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(receiver.requests.length, 1);
    const [received] = receiver.requests;
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/hooks/hyfib");
    assert.equal(received.headers["content-type"], "application/json");
    assert.equal(received.headers["user-agent"], "HyFib-Webhook/1.0");
    assert.deepEqual(JSON.parse(received.body), EVENT);
    const expected = `sha256=${createHmac("sha256", "whsec_1").update(received.body).digest("hex")}`;
    assert.equal(received.headers["x-hyfib-signature"], expected);
  } finally {
    await receiver.close();
  }
});

test("a redirect is a failed delivery and is never followed (the Location target is never requested)", async () => {
  const receiver = await startReceiver((req, res) => {
    if (req.url === "/hooks/hyfib") {
      res.statusCode = 307;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      res.end();
      return;
    }
    res.end("must not be reached");
  });
  try {
    const result = await deliverCustomerWebhook(
      { url: receiver.url("/hooks/hyfib"), secret: "whsec_1" },
      EVENT,
      loopbackTransport()
    );
    assert.deepEqual(result, { ok: false, status: 307 });
    assert.deepEqual(
      receiver.requests.map((r) => r.url),
      ["/hooks/hyfib"]
    );
  } finally {
    await receiver.close();
  }
});

test("an injected fetch is asked not to follow redirects, and a 3xx it returns is still a failure", async () => {
  let init;
  const result = await deliverCustomerWebhook(
    { url: "https://cb.example.com/h", secret: "s" },
    EVENT,
    async (_url, i) => {
      init = i;
      return { ok: true, status: 302 };
    }
  );
  assert.equal(init.redirect, "manual");
  assert.deepEqual(result, { ok: false, status: 302 });
});
