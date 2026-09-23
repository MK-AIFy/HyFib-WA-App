import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * The 503 an auth-store outage gets (see auth-unavailable-routes.test.js) is a refusal, never a fall-through. The
 * fall-through that would hurt most is dev-header mode (AUTH_ENABLED=false), where a request that reaches the end of
 * resolveAuth is answered as whoever its x-actor-id / x-role / x-tenant-id headers claim to be — so a credential
 * whose lookup failed must not get that far. Driven through the real HTTP handler.
 *
 * Nothing may reach a real Redis or Postgres (other projects' instances listen on this machine's default ports), so
 * both are pointed at 127.0.0.1:1 BEFORE the gateway, and with it the config, is imported.
 */
const TENANT_ID = "56565656-5656-4565-8565-565656565656";
process.env.AUTH_ENABLED = "false";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";
process.env.ORG_TENANT_ID = TENANT_ID;
delete process.env.ORG_NAME;
delete process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.BOOTSTRAP_ADMIN_PASSWORD;

const { createGatewayHandler } = await import("../dist/index.js");
const { getRedisClient } = await import("@hyfib/ratelimit");
const { apiKeyRepository, closePool, sessionRepository, teamRepository, tenantRepository } =
  await import("@hyfib/persistence");

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

const outage = () => Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });

let failing;
let teamsListed;
const originals = [];
function stub(repository, method, implementation) {
  originals.push([repository, method, repository[method]]);
  repository[method] = implementation;
}

let server;
let base;

before(async () => {
  // The rate limiters share this lazily-connecting client. Ending it before any request runs means its INCR is
  // rejected in-process (the limiters then fail open) instead of dialling port 1 and reconnecting forever.
  const redis = getRedisClient({ redis: { host: "127.0.0.1", port: 1, password: "" } });
  redis.disconnect();
  assert.equal(redis.status, "end", "the rate limiter's Redis client must be closed before any request is sent");

  stub(sessionRepository, "findByToken", async () => {
    if (failing) throw outage();
    return undefined;
  });
  stub(apiKeyRepository, "findActiveByHash", async () => {
    if (failing) throw outage();
    return undefined;
  });
  stub(tenantRepository, "getById", async (id) => ({ id, name: "Test Org", status: "active" }));
  stub(tenantRepository, "getUserCount", async () => 1);
  stub(teamRepository, "list", async () => {
    teamsListed += 1;
    return [];
  });

  const gateway = createGatewayHandler({ eventBus: stubBus });
  // Resolves the organization (ORG_TENANT_ID) the API-key path authenticates against.
  await gateway.bootstrapPlatformAdmin();
  server = createServer((req, res) => {
    gateway.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const [repository, method, original] of originals.reverse()) {
    repository[method] = original;
  }
  await new Promise((resolve) => server.close(resolve));
  await closePool().catch(() => undefined);
});

beforeEach(() => {
  failing = false;
  teamsListed = 0;
});

/** Dev-mode identity headers claiming a tenant_admin of the org. */
const claimedAdmin = {
  "Content-Type": "application/json",
  "x-actor-id": randomUUID(),
  "x-role": "tenant_admin",
  "x-tenant-id": TENANT_ID
};

async function send(headers) {
  const res = await fetch(`${base}/api/v1/teams`, { headers });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("control: the identity headers alone are answered as the caller they claim (dev mode)", async () => {
  const res = await send(claimedAdmin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(teamsListed, 1);
});

test("control: a session token that is simply unknown falls through to the identity headers, as it always has", async () => {
  const res = await send({ ...claimedAdmin, Authorization: `Bearer ${randomUUID()}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("a failing session or API-key lookup is refused with 503; it never falls through to the identity headers", async () => {
  failing = true;
  for (const [label, credential] of [
    ["Bearer session", { Authorization: `Bearer ${randomUUID()}${randomUUID()}` }],
    ["cookie session", { Cookie: `hf_session=${randomUUID()}${randomUUID()}` }],
    ["API key", { Authorization: `Bearer hyfib_${randomBytes(16).toString("hex")}` }]
  ]) {
    const res = await send({ ...claimedAdmin, ...credential });
    assert.equal(res.status, 503, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: "auth_unavailable", retryAfterSeconds: 5 }, label);
    assert.equal(res.retryAfter, "5", label);
  }
  assert.equal(teamsListed, 0, "no request was answered as the caller the headers claimed");
});
