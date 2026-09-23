import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// SAFETY: other projects' Redis and Postgres listen on this machine's default ports. Point both at port 1, where
// nothing listens, BEFORE the gateway (and the config it loads at import time) is evaluated — hence the dynamic
// imports below. Dev-header auth: identity comes from x-role / x-actor-id / x-tenant-id, so no session store.
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";
process.env.AUTH_ENABLED = "false";

const { createGatewayHandler } = await import("../dist/index.js");
const { parseStatusCallbackUrl } = await import("../dist/validation.js");
const { getPool, closePool } = await import("@hyfib/persistence");
const { getRedisClient, closeRedis } = await import("@hyfib/ratelimit");
const { loadConfig } = await import("@hyfib/config");

/**
 * PUT /api/v1/channels/whatsapp/settings through the real gateway handler: a statusCallbackUrl the outbound-URL
 * policy refuses is a 400 carrying the validator's own error, returned before any repository call. The unit tests
 * in status-callback-url.test.js cover the policy; this pins that the route actually runs it, and runs it first.
 *
 * Every repository call goes through the one lazily-created pool (query(), or connect() for a tenant
 * transaction). The test instruments that pool so each attempted database access is recorded and refused
 * in-process — nothing ever connects. The general rate limiter fails open when Redis is unavailable; the shared
 * (lazy, never-connected) client is closed up front so that path is taken at once instead of after ioredis's
 * reconnect retries, and no Redis connection is ever attempted either.
 */

getRedisClient(loadConfig()).disconnect();

const dbCalls = [];
const pool = getPool();
pool.query = async (text) => {
  dbCalls.push(typeof text === "string" ? text : text?.text);
  throw new Error("database access refused by the test");
};
pool.connect = async () => {
  dbCalls.push("connect");
  throw new Error("database access refused by the test");
};

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };
const gateway = createGatewayHandler({ eventBus: stubBus });
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

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await closeRedis();
  await closePool();
});

const TENANT_ID = "7c1e2b1a-3f4d-4e5f-8a9b-0c1d2e3f4a5b";
const ACTOR_ID = "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f";

function putSettings(body) {
  return fetch(`${base}/api/v1/channels/whatsapp/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-role": "tenant_admin",
      "x-actor-id": ACTOR_ID,
      "x-tenant-id": TENANT_ID
    },
    body: JSON.stringify(body)
  });
}

const DISALLOWED = [
  "http://169.254.169.254/latest",
  "http://127.0.0.1:8080/",
  "http://localhost../",
  "http://[::1]:5432/",
  "http://rabbitmq:15672/api/overview",
  "file:///etc/passwd",
  42
];

for (const statusCallbackUrl of DISALLOWED) {
  test(`PUT whatsapp settings rejects statusCallbackUrl ${JSON.stringify(statusCallbackUrl)} with 400 before any write`, async () => {
    const expected = parseStatusCallbackUrl(statusCallbackUrl);
    assert.equal(expected.ok, false, "precondition: the validator refuses this value");
    const before = dbCalls.length;

    const response = await putSettings({ statusCallbackUrl, retryMaxAttempts: 3 });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: expected.error });
    assert.deepEqual(dbCalls.slice(before), [], "the repository was called for a refused URL");
  });
}

test("PUT whatsapp settings with a public statusCallbackUrl passes the check and reaches the repository (control)", async () => {
  const before = dbCalls.length;

  const response = await putSettings({ statusCallbackUrl: "https://hooks.example.com/hyfib", retryMaxAttempts: 3 });

  // The refused-in-process database turns the upsert into a 500; what matters is that it was attempted, which
  // shows the 400s above come from the URL check and not from auth, the rate limiter or the tenant gate.
  assert.equal(response.status, 500);
  assert.ok(dbCalls.length > before, "a valid URL never reached the repository");
});
