import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

/**
 * Suspension is revocation: a session authenticates only while its user is active, suspending (or disabling, or
 * un-inviting) a user ends every session it holds, nobody changes their own status, and /auth/login refuses every
 * status but active. Driven through the real HTTP handler.
 *
 * The persistence singletons the gateway imports are plain objects, so their methods are replaced below with
 * in-memory stand-ins (and restored afterwards); the gateway sees the same objects. Nothing may reach a real Redis
 * or Postgres (other projects' instances listen on this machine's default ports), so both are pointed at
 * 127.0.0.1:1 BEFORE the gateway, and with it the config, is imported: a call that slipped past the stubs fails
 * instead of touching someone else's database.
 */
process.env.AUTH_ENABLED = "false";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";

const { createGatewayHandler } = await import("../dist/index.js");
const { getRedisClient } = await import("@hyfib/ratelimit");
const {
  apiKeyRepository,
  auditRepository,
  closePool,
  sessionRepository,
  teamRepository,
  tenantRepository,
  userRepository
} = await import("@hyfib/persistence");

const TENANT_ID = "88888888-8888-4888-8888-888888888888";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";
const PEER_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PASSWORD = "correct horse battery staple";
const NOT_ACTIVE = ["suspended", "disabled", "invited"];

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

// ─── In-memory persistence ────────────────────────────────────────────────────

const users = new Map();
const passwordHashes = new Map();
const sessions = new Map();
const apiKeys = [];
let calls;

// Postgres compares uuid values, not their spelling: an upper-case id in a path finds the same row. The user
// stand-ins key on the lower-cased id so they behave the same way.
const uid = (id) => String(id).toLowerCase();

/** Same format as the gateway's hashPassword: `<hex salt>:<hex scrypt(password, salt, 64)>`. */
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

// Hashed once: scrypt is deliberately slow, and every seeded user shares the password.
const PASSWORD_HASH = hashPassword(PASSWORD);

const tokenHash = (rawToken) => createHash("sha256").update(rawToken).digest("hex");

function seedUser(id, email, roles, status = "active") {
  users.set(id, { id, tenantId: TENANT_ID, email, displayName: email.split("@")[0], roles, status });
  passwordHashes.set(id, PASSWORD_HASH);
}

/** A live session, as /auth/login would have created it; returns the raw token the client holds. */
function openSession(userId) {
  const rawToken = randomUUID() + randomUUID();
  const now = Date.now();
  sessions.set(tokenHash(rawToken), {
    id: randomUUID(),
    userId,
    tenantId: TENANT_ID,
    tokenHash: tokenHash(rawToken),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  return rawToken;
}

const sessionsOf = (userId) => [...sessions.values()].filter((session) => session.userId === userId);

const originals = [];
function stub(repository, method, implementation) {
  originals.push([repository, method, repository[method]]);
  repository[method] = implementation;
}

function installStubs() {
  stub(sessionRepository, "findByToken", async (hash) => sessions.get(hash));
  stub(sessionRepository, "create", async (input) => {
    calls.sessionCreate.push(input);
    const session = { id: randomUUID(), ...input, expiresAt: "", createdAt: "" };
    sessions.set(input.tokenHash, session);
    return session;
  });
  stub(sessionRepository, "deleteByToken", async (hash) => {
    calls.sessionDeleteByToken.push(hash);
    sessions.delete(hash);
  });
  stub(sessionRepository, "deleteAllForUser", async (userId) => {
    calls.sessionDeleteAllForUser.push(userId);
    for (const [hash, session] of sessions) {
      if (uid(session.userId) === uid(userId)) {
        sessions.delete(hash);
      }
    }
  });
  stub(userRepository, "getById", async (tenantId, id) => {
    calls.userGetById.push(id);
    const user = users.get(uid(id));
    return user && user.tenantId === tenantId ? { ...user } : undefined;
  });
  stub(userRepository, "list", async () => [...users.values()].map((user) => ({ ...user })));
  stub(userRepository, "findByEmailForAuth", async (email) => {
    const user = [...users.values()].find((candidate) => candidate.email === email);
    return user ? { ...user, passwordHash: passwordHashes.get(user.id) } : undefined;
  });
  stub(userRepository, "updateStatus", async (tenantId, id, status) => {
    calls.userUpdateStatus.push({ id, status });
    users.get(uid(id)).status = status;
  });
  stub(userRepository, "updateRoles", async (tenantId, id, roles) => {
    calls.userUpdateRoles.push({ id, roles });
    users.get(uid(id)).roles = roles;
    return { ...users.get(uid(id)) };
  });
  stub(userRepository, "updatePassword", async (tenantId, id, passwordHash) => {
    calls.userUpdatePassword.push(id);
    passwordHashes.set(uid(id), passwordHash);
  });
  stub(userRepository, "create", async (tenantId, input) => {
    calls.userCreate.push(input);
    const user = {
      id: randomUUID(),
      tenantId,
      email: input.email,
      displayName: input.displayName,
      roles: input.roles,
      status: "active"
    };
    users.set(user.id, user);
    return { ...user };
  });
  stub(apiKeyRepository, "create", async (tenantId, input) => {
    calls.apiKeyCreate.push(input);
    const id = randomUUID();
    return {
      key: `hyfib_${randomBytes(16).toString("hex")}`,
      record: { id, tenantId, name: input.name, keyPrefix: "hyfib_00000000", roles: input.roles, createdAt: "" }
    };
  });
  stub(apiKeyRepository, "list", async () => apiKeys.map((key) => ({ ...key })));
  stub(apiKeyRepository, "revoke", async (tenantId, id) => {
    calls.apiKeyRevoke.push(id);
    return true;
  });
  stub(tenantRepository, "getById", async (id) => ({
    id,
    name: "Test Org",
    status: "active",
    plan: "trial",
    maxUsers: 10,
    createdAt: new Date(0).toISOString()
  }));
  stub(teamRepository, "list", async () => []);
  stub(auditRepository, "add", async (tenantId, event) => {
    calls.audit.push(event);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

let server;
let base;

before(async () => {
  // The rate limiters share this lazily-connecting client. Ending it before any request runs means its INCR is
  // rejected in-process (the limiters then fail open) instead of dialling port 1 and reconnecting forever.
  const redis = getRedisClient({ redis: { host: "127.0.0.1", port: 1, password: "" } });
  redis.disconnect();
  assert.equal(redis.status, "end", "the rate limiter's Redis client must be closed before any request is sent");

  installStubs();
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
  for (const [repository, method, original] of originals.reverse()) {
    repository[method] = original;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await closePool().catch(() => undefined);
});

afterEach(() => {
  // A stream a test left open would hold the server (and this process) open.
  for (const controller of openStreams.splice(0)) {
    controller.abort();
  }
});

beforeEach(() => {
  users.clear();
  passwordHashes.clear();
  sessions.clear();
  apiKeys.length = 0;
  calls = {
    sessionCreate: [],
    sessionDeleteByToken: [],
    sessionDeleteAllForUser: [],
    userGetById: [],
    userUpdateStatus: [],
    userUpdateRoles: [],
    userUpdatePassword: [],
    userCreate: [],
    apiKeyCreate: [],
    apiKeyRevoke: [],
    audit: []
  };
  seedUser(ADMIN_ID, "admin@example.com", ["tenant_admin"]);
  seedUser(PEER_ADMIN_ID, "peer.admin@example.com", ["tenant_admin"]);
  seedUser(AGENT_ID, "agent@example.com", ["support_agent"]);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const bearer = (rawToken, extra = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${rawToken}`,
  ...extra
});
const cookie = (rawToken) => ({
  "Content-Type": "application/json",
  Cookie: `hf_session=${rawToken}`,
  "x-requested-with": "fetch"
});
const anonymous = { "Content-Type": "application/json" };

async function send(method, path, headers, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookie: res.headers.get("set-cookie") };
}

function assertStatus(response, expected, message) {
  assert.equal(
    response.status,
    expected,
    `${message}: expected ${expected}, got ${response.status} ${JSON.stringify(response.body)}`
  );
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `condition()` holds; fails the test after `timeoutMs`. */
async function waitUntil(condition, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting until ${message}`);
    }
    await pause(5);
  }
}

// ─── SSE streams ──────────────────────────────────────────────────────────────

const openStreams = [];

/** Opens GET /api/v1/events/stream and waits for the ": connected" preamble. */
async function openStream(headers) {
  const controller = new AbortController();
  openStreams.push(controller);
  const res = await fetch(`${base}/api/v1/events/stream`, { headers, signal: controller.signal });
  assert.equal(res.status, 200, "the SSE stream opens");
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /: connected/);
  let ended = false;
  // Drain in the background; `ended` flips once the server ends the response.
  const drained = (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          ended = true;
          return;
        }
      }
    } catch {
      // Aborted by the test itself: not a server-side close.
    }
  })();
  return {
    isEnded: () => ended,
    waitEnded: (message) => waitUntil(() => ended, message),
    abort: async () => {
      controller.abort();
      await drained;
    }
  };
}

// ─── A request whose body arrives late ────────────────────────────────────────

/**
 * Sends the headers of a request now and its body only when `release()` is called, the way a slow or deliberately
 * stalled client can. `started` resolves once the gateway has authenticated the request (its session's user has
 * been read), so the test can change the world between authentication and the body.
 */
function stalledRequest(method, path, headers, body) {
  const payload = JSON.stringify(body);
  const reads = calls.userGetById.length;
  const req = httpRequest(`${base}${path}`, {
    method,
    headers: { ...headers, "Content-Length": Buffer.byteLength(payload) }
  });
  const response = new Promise((resolve, reject) => {
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
  });
  req.flushHeaders();
  return {
    started: waitUntil(() => calls.userGetById.length > reads, `${method} ${path} is authenticated`),
    release: () => {
      req.end(payload);
      return response;
    }
  };
}

// ─── Log capture ──────────────────────────────────────────────────────────────

/** Runs `fn` and returns the gateway's structured log lines written meanwhile (still passed through to stdout). */
async function captureLogs(fn) {
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("{")) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          // Not a log line.
        }
      }
    }
    return write.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return lines.filter((line) => line.component === "api-gateway");
}

// ─── A session of a user who is not active does not authenticate ───────────

test("a suspended, disabled or invited user's still-valid session is refused with 401 on an ordinary route", async () => {
  for (const status of NOT_ACTIVE) {
    const viaBearer = openSession(AGENT_ID);
    const viaCookie = openSession(AGENT_ID);
    // Control: the same tokens work while the user is active, so a refusal below is the status check and nothing else.
    assertStatus(await send("GET", "/api/v1/teams", bearer(viaBearer)), 200, "active user's session by Bearer");
    assertStatus(await send("GET", "/api/v1/teams", cookie(viaCookie)), 200, "active user's session by cookie");

    // The status changes underneath sessions that were never revoked (the state every session of a user
    // suspended before this fix is in).
    users.get(AGENT_ID).status = status;
    const byBearer = await send("GET", "/api/v1/teams", bearer(viaBearer));
    assertStatus(byBearer, 401, `${status} user's session by Bearer`);
    assert.equal(byBearer.body.error, "unauthenticated");
    assertStatus(await send("GET", "/api/v1/teams", cookie(viaCookie)), 401, `${status} user's session by cookie`);

    // A refused session is revoked on sight, so reactivating the user later does not bring it back.
    assert.deepEqual(sessionsOf(AGENT_ID), [], `${status} user's refused sessions must be deleted`);
    users.get(AGENT_ID).status = "active";
  }
});

test("a refused session fails hard: it never falls through to another identity on the same request", async () => {
  users.get(AGENT_ID).status = "suspended";
  const token = openSession(AGENT_ID);
  // In dev-header mode the fallback would make this caller a tenant_admin; a known session of a suspended user
  // must be answered as that user (refused), exactly as an unknown or revoked API key is.
  const res = await send(
    "GET",
    "/api/v1/users",
    bearer(token, { "x-role": "tenant_admin", "x-actor-id": PEER_ADMIN_ID, "x-tenant-id": TENANT_ID })
  );
  assertStatus(res, 401, "suspended user's Bearer session alongside dev identity headers");
});

test("a suspended admin's live session can neither reactivate itself, create a user nor mint an API key", async () => {
  const token = openSession(ADMIN_ID);
  users.get(ADMIN_ID).status = "suspended";

  const reactivate = await send("PATCH", `/api/v1/users/${ADMIN_ID}`, bearer(token), { status: "active" });
  assertStatus(reactivate, 401, "suspended admin PATCHing its own status back to active");

  const backdoor = await send("POST", "/api/v1/users", bearer(openSession(ADMIN_ID)), {
    email: "backdoor.admin@example.com",
    displayName: "Backdoor Admin",
    roles: ["tenant_admin"]
  });
  assertStatus(backdoor, 401, "suspended admin creating a tenant_admin");
  assert.equal(backdoor.body.tempPassword, undefined, "no credential may come back to a suspended admin");

  const key = await send("POST", "/api/v1/api-keys", bearer(openSession(ADMIN_ID)), {
    name: "parting-gift",
    roles: ["tenant_admin"]
  });
  assertStatus(key, 401, "suspended admin minting a tenant_admin API key");

  assert.equal(users.get(ADMIN_ID).status, "suspended", "the admin stays suspended");
  assert.deepEqual(calls.userUpdateStatus, [], "no status was written");
  assert.deepEqual(calls.userCreate, [], "no user was created");
  assert.deepEqual(calls.apiKeyCreate, [], "no API key was created");
});

test("/auth/me does not report a suspended user's session as signed in", async () => {
  const token = openSession(AGENT_ID);
  assertStatus(await send("GET", "/auth/me", bearer(token)), 200, "control: active user's /auth/me");

  users.get(AGENT_ID).status = "suspended";
  const me = await send("GET", "/auth/me", bearer(token));
  assertStatus(me, 401, "suspended user's /auth/me");
  assert.equal(me.body.email, undefined, "no profile is returned for a suspended user's session");
});

// ─── Suspending revokes ────────────────────────────────────────────────────────

test("setting a user's status to anything but active revokes every session it holds, at once", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  for (const status of NOT_ACTIVE) {
    users.get(AGENT_ID).status = "active";
    const agentTokens = [openSession(AGENT_ID), openSession(AGENT_ID)];
    calls.sessionDeleteAllForUser.length = 0;

    const res = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status });
    assertStatus(res, 200, `tenant_admin setting an agent to ${status}`);
    assert.equal(res.body.status, status);

    assert.deepEqual(calls.sessionDeleteAllForUser, [AGENT_ID], `${status}: the agent's sessions are revoked`);
    assert.deepEqual(sessionsOf(AGENT_ID), [], `${status}: no session of the agent survives`);
    assert.equal(sessionsOf(PEER_ADMIN_ID).length, 1, `${status}: the acting admin's own session is untouched`);
    for (const token of agentTokens) {
      const after = await send("GET", "/api/v1/teams", bearer(token));
      assert.notEqual(after.status, 200, `${status}: a revoked token no longer authenticates`);
    }
    assert.equal(calls.audit.at(-1).payload.sessionsRevoked, true, `${status}: the audit row records the revocation`);
  }
});

test("setting an already-active user to active, and changing only roles, leave its sessions alone", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  openSession(AGENT_ID);

  const reactivate = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status: "active" });
  assertStatus(reactivate, 200, "tenant_admin setting an active agent to active");
  assert.equal(reactivate.body.keysCreatedByUser, undefined, "keys are listed only when a user is taken out");
  const reRole = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { roles: ["analyst"] });
  assertStatus(reRole, 200, "tenant_admin changing an agent's roles");

  assert.deepEqual(calls.sessionDeleteAllForUser, []);
  assert.equal(sessionsOf(AGENT_ID).length, 1);
});

// ─── Nobody changes their own status ──────────────────────────────────────────

test("an admin cannot change its own status, to suspended, disabled or back to active", async () => {
  const token = openSession(ADMIN_ID);
  for (const status of ["suspended", "disabled", "invited", "active"]) {
    const res = await send("PATCH", `/api/v1/users/${ADMIN_ID}`, bearer(token), { status });
    assertStatus(res, 403, `tenant_admin setting its own status to ${status}`);
    assert.equal(res.body.error, "cannot_change_own_status");
  }
  assert.deepEqual(calls.userUpdateStatus, [], "no status was written");
  assert.deepEqual(calls.sessionDeleteAllForUser, [], "no session was revoked");
  assert.equal(users.get(ADMIN_ID).status, "active");
});

test("the own-status rule holds for a caller that is not session-authenticated too", async () => {
  // A dev-header (or Keycloak JWT) caller never goes through the session status check, so the rule itself must
  // stop an admin whose account is suspended from reactivating itself.
  users.get(ADMIN_ID).status = "suspended";
  const res = await send(
    "PATCH",
    `/api/v1/users/${ADMIN_ID}`,
    { ...anonymous, "x-actor-id": ADMIN_ID, "x-role": "tenant_admin", "x-tenant-id": TENANT_ID },
    { status: "active" }
  );
  assertStatus(res, 403, "header-authenticated suspended admin reactivating itself");
  assert.equal(res.body.error, "cannot_change_own_status");
  assert.equal(users.get(ADMIN_ID).status, "suspended");
});

// ─── Login refuses every status but active ─────────────────────────────────────

test("/auth/login refuses suspended, disabled and invited accounts, and creates no session", async () => {
  const expected = {
    suspended: "Account is suspended",
    disabled: "Account is disabled",
    invited: "Account is not active"
  };
  for (const status of NOT_ACTIVE) {
    users.get(AGENT_ID).status = status;
    const res = await send("POST", "/auth/login", anonymous, { email: "agent@example.com", password: PASSWORD });
    assertStatus(res, 403, `login as a ${status} user`);
    assert.equal(res.body.error, expected[status]);
    assert.equal(res.body.token, undefined, `${status}: no token`);
    assert.equal(res.setCookie, null, `${status}: no session cookie`);
  }
  assert.deepEqual(calls.sessionCreate, [], "no session was created for an account that is not active");
});

test("/auth/login does not reveal an account's status to a caller without its password", async () => {
  users.get(AGENT_ID).status = "suspended";
  const res = await send("POST", "/auth/login", anonymous, { email: "agent@example.com", password: "wrong password" });
  assertStatus(res, 401, "login as a suspended user with the wrong password");
  assert.equal(res.body.error, "Invalid email or password");
});

test("/auth/login still signs in an active account", async () => {
  const res = await send("POST", "/auth/login", anonymous, { email: "agent@example.com", password: PASSWORD });
  assertStatus(res, 200, "login as an active user");
  assert.equal(typeof res.body.token, "string");
  assert.equal(calls.sessionCreate.length, 1);
  assert.equal(calls.sessionCreate[0].userId, AGENT_ID);
});

// ─── Revoking a credential ends the event streams it opened ───────────────────
// /api/v1/events/stream is authorised once, at connect, and then carries every tenant event (inbound message
// content included) for as long as it stays open. Whatever ends a session must end its streams too.

test("suspending a user ends every event stream it has open, and leaves everyone else's", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  const agentByBearer = await openStream(bearer(openSession(AGENT_ID)));
  const agentByCookie = await openStream(cookie(openSession(AGENT_ID)));
  const adminStream = await openStream(bearer(adminToken));

  const logs = await captureLogs(async () => {
    const res = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status: "suspended" });
    assertStatus(res, 200, "tenant_admin suspending an agent");
  });

  await agentByBearer.waitEnded("the suspended agent's Bearer-authenticated stream is ended");
  await agentByCookie.waitEnded("the suspended agent's cookie-authenticated stream is ended");
  await pause(50);
  assert.equal(adminStream.isEnded(), false, "the acting admin's stream stays open");
  const closed = logs.find((line) => line.message === "sse_streams_closed");
  assert.equal(closed?.userId, AGENT_ID, "the closure is logged against the suspended user");
  assert.equal(closed?.count, 2);
});

test("an admin's password reset ends the user's event streams along with its sessions", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  const agentStream = await openStream(bearer(openSession(AGENT_ID)));

  const res = await send("POST", `/api/v1/users/${AGENT_ID}/set-password`, bearer(adminToken), {
    password: "a brand new password"
  });
  assertStatus(res, 200, "tenant_admin resetting an agent's password");
  await agentStream.waitEnded("the agent's stream is ended once its sessions are revoked");
});

test("a password reset deletes the sessions before it ends the streams, so a reconnect in between finds none", async () => {
  // The user stays active across a password set, so the per-request status check does not stop a reconnect: if
  // the streams ended first, a reconnect in that gap could authenticate with a session about to be deleted and
  // hold a fresh stream until the lifetime cap. The delete's position is marked in the captured log stream.
  const adminToken = openSession(PEER_ADMIN_ID);
  await openStream(bearer(openSession(AGENT_ID)));
  const deleteAllForUser = sessionRepository.deleteAllForUser;
  sessionRepository.deleteAllForUser = async (userId) => {
    // Tagged like the gateway's own lines so captureLogs keeps it, in order.
    process.stdout.write(`${JSON.stringify({ component: "api-gateway", message: "test_sessions_deleted", userId })}\n`);
    return deleteAllForUser(userId);
  };
  let logs;
  try {
    logs = await captureLogs(async () => {
      const res = await send("POST", `/api/v1/users/${AGENT_ID}/set-password`, bearer(adminToken), {
        password: "a brand new password"
      });
      assertStatus(res, 200, "tenant_admin resetting an agent's password");
    });
  } finally {
    sessionRepository.deleteAllForUser = deleteAllForUser;
  }
  const deleted = logs.findIndex((line) => line.message === "test_sessions_deleted");
  const streamsClosed = logs.findIndex((line) => line.message === "sse_streams_closed");
  assert.ok(deleted >= 0, "the sessions were deleted");
  assert.ok(streamsClosed >= 0, "the streams were ended");
  assert.ok(deleted < streamsClosed, "the sessions go first, then the streams");
});

test("if revoking the sessions fails during a password set, the change is still answered, audited and the streams end", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  const agentStream = await openStream(bearer(openSession(AGENT_ID)));
  const deleteAllForUser = sessionRepository.deleteAllForUser;
  sessionRepository.deleteAllForUser = async () => {
    throw new Error("connection reset");
  };
  let res;
  let logs;
  try {
    logs = await captureLogs(async () => {
      res = await send("POST", `/api/v1/users/${AGENT_ID}/set-password`, bearer(adminToken), {
        password: "a brand new password"
      });
    });
  } finally {
    sessionRepository.deleteAllForUser = deleteAllForUser;
  }

  assertStatus(res, 200, "password set whose session revocation failed");
  const row = calls.audit.at(-1);
  assert.equal(row?.action, "user.password_reset", "the reset is audited");
  assert.equal(row.payload.sessionsRevoked, false, "the audit row says the sessions were not revoked");
  const failure = logs.find((line) => line.message === "user_sessions_revoke_failed");
  assert.equal(failure?.level, "error");
  assert.equal(failure?.userId, AGENT_ID);
  await agentStream.waitEnded("the streams still end when the session delete fails");
});

test("logging out ends the streams opened with that session, and only those", async () => {
  const loggingOut = openSession(AGENT_ID);
  const otherDevice = openSession(AGENT_ID);
  const loggedOutStream = await openStream(bearer(loggingOut));
  const otherDeviceStream = await openStream(bearer(otherDevice));

  assertStatus(await send("POST", "/auth/logout", bearer(loggingOut)), 200, "logout");

  await loggedOutStream.waitEnded("the logged-out session's stream is ended");
  await pause(50);
  assert.equal(otherDeviceStream.isEnded(), false, "a stream of the same user's other session stays open");
});

test("a session refused for an inactive user ends that user's streams on this instance too", async () => {
  // Suspended by another gateway instance: this one never saw the PATCH, only the status in the database.
  const streamed = await openStream(bearer(openSession(AGENT_ID)));
  const presented = openSession(AGENT_ID);
  users.get(AGENT_ID).status = "suspended";

  assertStatus(await send("GET", "/api/v1/teams", bearer(presented)), 401, "suspended user's session");
  await streamed.waitEnded("the user's open stream is ended as soon as one of its sessions is refused");
});

// ─── The API keys a suspended admin leaves behind ─────────────────────────────
// A key outlives its creator's suspension by design (revoking it is a deliberate act), so the suspending admin is
// shown the keys that user created instead of having them revoked behind its back.

test("taking a user out lists the active API keys it created, without revoking any or showing a secret", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  const createdAt = new Date(0).toISOString();
  const theirs = {
    id: randomUUID(),
    tenantId: TENANT_ID,
    name: "zapier",
    keyPrefix: "hyfib_1a2b3c4d",
    roles: ["tenant_admin"],
    createdBy: ADMIN_ID,
    lastUsedAt: createdAt,
    createdAt,
    keyHash: "never-in-a-response"
  };
  apiKeys.push(
    theirs,
    { ...theirs, id: randomUUID(), name: "already revoked", revokedAt: createdAt },
    { ...theirs, id: randomUUID(), name: "a colleague's", createdBy: PEER_ADMIN_ID },
    { ...theirs, id: randomUUID(), name: "creator unknown", createdBy: undefined }
  );

  for (const status of NOT_ACTIVE) {
    users.get(ADMIN_ID).status = "active";
    let res;
    const logs = await captureLogs(async () => {
      res = await send("PATCH", `/api/v1/users/${ADMIN_ID}`, bearer(adminToken), { status });
    });
    assertStatus(res, 200, `tenant_admin setting a tenant_admin to ${status}`);
    assert.deepEqual(
      res.body.keysCreatedByUser,
      [{ id: theirs.id, name: "zapier", prefix: "hyfib_1a2b3c4d", createdAt }],
      `${status}: exactly the user's active keys, as id, name, prefix and createdAt`
    );
    assert.equal(JSON.stringify(res.body).includes("never-in-a-response"), false, "no key hash leaks");
    const warning = logs.find((line) => line.message === "user_suspended_with_active_keys");
    assert.equal(warning?.level, "warn", `${status}: the leftover keys are logged`);
    assert.equal(warning?.userId, ADMIN_ID);
    assert.equal(warning?.count, 1);
  }
  assert.deepEqual(calls.apiKeyRevoke, [], "no key is revoked automatically");

  // A user with no keys gets an empty list and no warning.
  let res;
  const logs = await captureLogs(async () => {
    res = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status: "suspended" });
  });
  assertStatus(res, 200, "suspending an agent with no keys");
  assert.deepEqual(res.body.keysCreatedByUser, []);
  assert.equal(
    logs.some((line) => line.message === "user_suspended_with_active_keys"),
    false
  );
});

// ─── Suspended while the request body is still arriving ───────────────────────
// The identity-admin routes authenticate when the headers arrive and read the body afterwards. A request stalled
// in between must not complete a write for an admin who was suspended meanwhile.

const LATE_WRITES = [
  {
    method: "POST",
    path: "/api/v1/users",
    body: { email: "late.admin@example.com", displayName: "Late Admin", roles: ["tenant_admin"] },
    writes: () => calls.userCreate.length
  },
  {
    method: "POST",
    path: "/api/v1/api-keys",
    body: { name: "late-key", roles: ["tenant_admin"] },
    writes: () => calls.apiKeyCreate.length
  },
  {
    method: "PATCH",
    path: `/api/v1/users/${AGENT_ID}`,
    body: { roles: ["tenant_admin"], status: "active" },
    writes: () => calls.userUpdateRoles.length + calls.userUpdateStatus.length
  },
  {
    method: "POST",
    path: `/api/v1/users/${AGENT_ID}/set-password`,
    body: { password: "a brand new password" },
    writes: () => calls.userUpdatePassword.length
  }
];

test("control: a stalled identity-admin request from an admin who stays active completes", async () => {
  const request = stalledRequest("POST", "/api/v1/api-keys", bearer(openSession(ADMIN_ID)), LATE_WRITES[1].body);
  await request.started;
  assertStatus(await request.release(), 201, "stalled API-key creation by an active admin");
});

for (const write of LATE_WRITES) {
  test(`${write.method} ${write.path}: an admin suspended after authentication but before its body arrived writes nothing`, async () => {
    const request = stalledRequest(write.method, write.path, bearer(openSession(ADMIN_ID)), write.body);
    await request.started;
    users.get(ADMIN_ID).status = "suspended";

    const res = await request.release();
    assertStatus(res, 401, `${write.method} ${write.path} completed after its admin was suspended`);
    assert.equal(write.writes(), 0, `${write.method} ${write.path}: nothing was written`);
    assert.equal(res.body.tempPassword, undefined, "no temporary password");
    assert.equal(res.body.key, undefined, "no API key");
  });
}

// ─── Reactivation starts from a clean slate ───────────────────────────────────

test("reactivating a user revokes the sessions it had left over, so an old token does not come back", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  for (const status of NOT_ACTIVE) {
    users.get(AGENT_ID).status = status;
    // Left over from before the suspension and never presented since, so nothing has revoked it yet.
    const leftover = openSession(AGENT_ID);
    calls.sessionDeleteAllForUser.length = 0;

    const res = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status: "active" });
    assertStatus(res, 200, `reactivating a ${status} agent`);
    assert.deepEqual(calls.sessionDeleteAllForUser, [AGENT_ID], `${status} → active: the sessions are revoked`);
    assert.deepEqual(sessionsOf(AGENT_ID), [], `${status} → active: no leftover session survives`);
    assert.equal(calls.audit.at(-1).payload.sessionsRevoked, true, `${status} → active: recorded in the audit row`);

    assertStatus(await send("GET", "/auth/me", bearer(leftover)), 401, `${status} → active: the old token`);
    assert.notEqual((await send("GET", "/api/v1/teams", bearer(leftover))).status, 200);
  }
  // The reactivated user signs in afresh.
  const login = await send("POST", "/auth/login", anonymous, { email: "agent@example.com", password: PASSWORD });
  assertStatus(login, 200, "the reactivated agent signs in");
});

// ─── A failed revocation does not fail the suspension ─────────────────────────

test("if revoking the sessions fails after the status is written, the change is still answered, audited and enforced", async () => {
  const adminToken = openSession(PEER_ADMIN_ID);
  const agentToken = openSession(AGENT_ID);
  const deleteAllForUser = sessionRepository.deleteAllForUser;
  sessionRepository.deleteAllForUser = async () => {
    throw new Error("connection reset");
  };
  let res;
  let logs;
  try {
    logs = await captureLogs(async () => {
      res = await send("PATCH", `/api/v1/users/${AGENT_ID}`, bearer(adminToken), { status: "suspended" });
    });
  } finally {
    sessionRepository.deleteAllForUser = deleteAllForUser;
  }

  assertStatus(res, 200, "suspension whose session revocation failed");
  assert.equal(res.body.status, "suspended");
  assert.equal(users.get(AGENT_ID).status, "suspended");
  const row = calls.audit.at(-1);
  assert.equal(row?.action, "user.updated", "the change is audited");
  assert.equal(row.payload.status, "suspended");
  assert.equal(row.payload.sessionsRevoked, false, "the audit row says the sessions were not revoked");
  const failure = logs.find((line) => line.message === "user_sessions_revoke_failed");
  assert.equal(failure?.level, "error");
  assert.equal(failure?.userId, AGENT_ID);
  assert.equal(failure?.error, "connection reset");
  assert.equal(
    logs.some((line) => line.message === "user_sessions_revoked"),
    false
  );

  // The per-request status check still keeps the user out.
  assertStatus(await send("GET", "/api/v1/teams", bearer(agentToken)), 401, "the suspended agent's surviving session");
});

// ─── Self is self, however the id in the path is spelled ──────────────────────

test("an upper-cased own id in the path cannot be used to change your own roles or status", async () => {
  // PEER_ADMIN_ID is spelled with letters, so upper-casing it really changes the string.
  const token = openSession(PEER_ADMIN_ID);
  const shouted = PEER_ADMIN_ID.toUpperCase();
  assert.notEqual(shouted, PEER_ADMIN_ID);

  const roles = await send("PATCH", `/api/v1/users/${shouted}`, bearer(token), { roles: ["analyst"] });
  assertStatus(roles, 403, "tenant_admin changing its own roles via an upper-cased id");
  assert.equal(roles.body.error, "cannot_change_own_roles");

  const status = await send("PATCH", `/api/v1/users/${shouted}`, bearer(token), { status: "suspended" });
  assertStatus(status, 403, "tenant_admin changing its own status via an upper-cased id");
  assert.equal(status.body.error, "cannot_change_own_status");

  assert.deepEqual(calls.userUpdateRoles, []);
  assert.deepEqual(calls.userUpdateStatus, []);
  assert.deepEqual(users.get(PEER_ADMIN_ID).roles, ["tenant_admin"]);
});

test("an upper-cased own id in the path sets your own password, and is audited as your own change", async () => {
  const agent = await send(
    "POST",
    `/api/v1/users/${AGENT_ID.toUpperCase()}/set-password`,
    bearer(openSession(AGENT_ID)),
    {
      password: "a brand new password"
    }
  );
  assertStatus(agent, 200, "an agent setting its own password via an upper-cased id");
  assert.equal(calls.audit.at(-1).action, "user.password_changed");

  const admin = await send(
    "POST",
    `/api/v1/users/${PEER_ADMIN_ID.toUpperCase()}/set-password`,
    bearer(openSession(PEER_ADMIN_ID)),
    {
      password: "another new password"
    }
  );
  assertStatus(admin, 200, "an admin setting its own password via an upper-cased id");
  assert.equal(calls.audit.at(-1).action, "user.password_changed", "not recorded as a reset of someone else");
  assert.equal(calls.audit.at(-1).resourceId, PEER_ADMIN_ID, "the audit row names the canonical id");
});

// ─── /auth/me drops the cookie of a session it refuses ────────────────────────

test("/auth/me clears the session cookie when it refuses the cookie's session for an inactive user", async () => {
  users.get(AGENT_ID).status = "suspended";
  const viaCookie = await send("GET", "/auth/me", cookie(openSession(AGENT_ID)));
  assertStatus(viaCookie, 401, "suspended user's /auth/me by cookie");
  assert.match(viaCookie.setCookie ?? "", /^hf_session=;/, "the cookie is cleared");
  assert.match(viaCookie.setCookie, /Max-Age=0/);

  // A refused Bearer session with no cookie has nothing to clear.
  const viaBearer = await send("GET", "/auth/me", bearer(openSession(AGENT_ID)));
  assertStatus(viaBearer, 401, "suspended user's /auth/me by Bearer");
  assert.equal(viaBearer.setCookie, null);
});
