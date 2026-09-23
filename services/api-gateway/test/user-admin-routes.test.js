import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * Route wiring for the user and credential gates in authorization.ts, driven through the real HTTP handler.
 * authorization.test.js pins the decisions themselves; this file pins that each route actually asks for one,
 * so deleting a gate call from index.ts fails here instead of silently reopening the hole.
 *
 * Dev-header auth (AUTH_ENABLED=false) lets a test claim any caller: resolveAuth gives an API key the subject
 * `apikey:<key id>`, and that prefix is all isApiKeyCaller keys on, so an x-actor-id of that shape is treated
 * exactly like a real key.
 *
 * Nothing here may reach a real Redis or Postgres (other projects' instances listen on this machine's default
 * ports), so both are pointed at 127.0.0.1:1 BEFORE the gateway, and with it the config, is imported. That also
 * makes every 403 below proof that the refusal came before any repository call: with Postgres unreachable, a
 * route that consulted the database first would answer 500.
 */
process.env.AUTH_ENABLED = "false";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";

const { createGatewayHandler } = await import("../dist/index.js");
const { getRedisClient } = await import("@hyfib/ratelimit");
const { closePool } = await import("@hyfib/persistence");

const TENANT_ID = "66666666-6666-4666-8666-666666666666";
const TARGET_USER_ID = "77777777-7777-4777-8777-777777777777";

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

let server;
let base;

before(async () => {
  // The general rate limiter shares this lazily-connecting client. Ending it before any request runs means its
  // INCR is rejected in-process (the limiter then fails open) instead of dialling port 1 and reconnecting forever,
  // which would hold this test process open after the last test.
  const redis = getRedisClient({ redis: { host: "127.0.0.1", port: 1, password: "" } });
  redis.disconnect();
  assert.equal(redis.status, "end", "the rate limiter's Redis client must be closed before any request is sent");

  const gateway = createGatewayHandler({ eventBus: stubBus });
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
  await new Promise((resolve) => server.close(resolve));
  await closePool().catch(() => undefined);
});

/** Headers for a dev-mode caller. */
function caller(actorId, roles) {
  return {
    "Content-Type": "application/json",
    "x-actor-id": actorId,
    "x-role": roles.join(","),
    "x-tenant-id": TENANT_ID
  };
}

const apiKeyAdmin = () => caller(`apikey:${randomUUID()}`, ["tenant_admin"]);
const humanTenantAdmin = () => caller(randomUUID(), ["tenant_admin"]);

async function send(method, path, headers, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function assertRefused(response, error, message) {
  assert.equal(
    response.status,
    403,
    `${message}: expected 403 ${error}, got ${response.status} ${JSON.stringify(response.body)}`
  );
  assert.equal(response.body.error, error, message);
}

test("an API key with tenant_admin cannot create a user (the response would carry a tempPassword)", async () => {
  const res = await send("POST", "/api/v1/users", apiKeyAdmin(), {
    email: "minted.by.key@example.com",
    displayName: "Minted By Key",
    roles: ["support_agent"]
  });
  assertRefused(res, "api_key_forbidden", "POST /api/v1/users by API key");
  assert.match(res.body.detail, /API keys/);
});

test("an API key with tenant_admin cannot change a user's roles or status", async () => {
  const promote = await send("PATCH", `/api/v1/users/${TARGET_USER_ID}`, apiKeyAdmin(), { roles: ["tenant_admin"] });
  assertRefused(promote, "api_key_forbidden", "PATCH /api/v1/users/:id roles by API key");

  const suspend = await send("PATCH", `/api/v1/users/${TARGET_USER_ID}`, apiKeyAdmin(), { status: "suspended" });
  assertRefused(suspend, "api_key_forbidden", "PATCH /api/v1/users/:id status by API key");
});

test("an API key with tenant_admin cannot set a password, whether or not the user exists", async () => {
  // Refused before the target lookup, so the answer is the same for any id and never touches the database.
  for (const userId of [TARGET_USER_ID, randomUUID()]) {
    const res = await send("POST", `/api/v1/users/${userId}/set-password`, apiKeyAdmin(), {
      password: "a-long-enough-password"
    });
    assertRefused(res, "api_key_forbidden", `POST /api/v1/users/${userId}/set-password by API key`);
  }
});

test("an API key with tenant_admin cannot mint another API key", async () => {
  const res = await send("POST", "/api/v1/api-keys", apiKeyAdmin(), {
    name: "minted-by-a-key",
    roles: ["tenant_admin"]
  });
  assertRefused(res, "api_key_forbidden", "POST /api/v1/api-keys by API key");
});

test("a signed-in tenant_admin cannot create a platform_owner", async () => {
  const res = await send("POST", "/api/v1/users", humanTenantAdmin(), {
    email: "would.be.owner@example.com",
    displayName: "Would Be Owner",
    roles: ["platform_owner"]
  });
  assertRefused(res, "role_not_grantable", "POST /api/v1/users with platform_owner by tenant_admin");
  assert.match(res.body.detail, /platform_owner/);
});
