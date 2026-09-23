import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:http";

/**
 * When the gateway cannot reach the store it checks credentials against, it answers 503 auth_unavailable with a
 * Retry-After, not 401: a Postgres blip is not a bad login, and a 401 made every client (the web app's event stream
 * first among them, which reconnects on its own) sign its user out. A credential that is actually refused still gets
 * the 401 it got before. Driven through the real HTTP handler with AUTH_ENABLED=true, the production shape, where
 * an unknown session token falls through to the Keycloak authenticator and is refused there.
 *
 * The persistence singletons the gateway imports are plain objects, so their methods are replaced below with
 * in-memory stand-ins that can be told to fail (and are restored afterwards). Nothing may reach a real Redis,
 * Postgres or Keycloak (other projects' instances listen on this machine's default ports), so all three are pointed
 * at 127.0.0.1:1 BEFORE the gateway, and with it the config, is imported. That also gives one test a genuine outage:
 * the real session repository, dialling a port where nothing listens.
 */
const TENANT_ID = "12121212-1212-4121-8121-121212121212";
process.env.AUTH_ENABLED = "true";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "1";
process.env.KEYCLOAK_JWKS_URI = "http://127.0.0.1:1/protocol/openid-connect/certs";
process.env.ORG_TENANT_ID = TENANT_ID;
delete process.env.ORG_NAME;
delete process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.BOOTSTRAP_ADMIN_PASSWORD;

const { createGatewayHandler } = await import("../dist/index.js");
const { getRedisClient } = await import("@hyfib/ratelimit");
const { apiKeyRepository, closePool, hashApiKey, sessionRepository, teamRepository, tenantRepository, userRepository } =
  await import("@hyfib/persistence");

const USER_ID = "34343434-3434-4343-8343-343434343434";
const EMAIL = "agent@example.com";
const PASSWORD = "correct horse battery staple";
const PASSWORD_HASH = (() => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
})();

const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

// ─── Failures to inject ───────────────────────────────────────────────────────

/** Node's error for a refused connection, as pg raises it when Postgres is down. */
const connectionRefused = () =>
  Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
    errno: -61,
    syscall: "connect",
    address: "10.0.0.5",
    port: 5432
  });
/** pg-pool's error when every connection is busy for connectionTimeoutMillis. */
const poolExhausted = () => new Error("timeout exceeded when trying to connect");
/** A server-reported failure: the database is shutting down under the gateway. */
const adminShutdown = () =>
  Object.assign(new Error("terminating connection due to administrator command"), {
    name: "error",
    code: "57P01",
    severity: "FATAL"
  });
/** A server-reported failure: max_connections reached. */
const tooManyConnections = () =>
  Object.assign(new Error("sorry, too many clients already"), { name: "error", code: "53300", severity: "FATAL" });
const OUTAGES = { connectionRefused, poolExhausted, adminShutdown, tooManyConnections };

/** Delegate to the real repository method (and so to the real, unreachable, database). */
const REAL = Symbol("real");

// ─── In-memory persistence ────────────────────────────────────────────────────

const users = new Map();
const sessions = new Map();
const apiKeys = new Map();
let faults;
let calls;

const tokenHash = (rawToken) => createHash("sha256").update(rawToken).digest("hex");

function openSession(userId = USER_ID, { expired = false } = {}) {
  const rawToken = randomUUID() + randomUUID();
  sessions.set(tokenHash(rawToken), {
    id: randomUUID(),
    userId,
    tenantId: TENANT_ID,
    tokenHash: tokenHash(rawToken),
    expiresAt: new Date(Date.now() + (expired ? -60_000 : 3_600_000)).toISOString(),
    createdAt: new Date().toISOString()
  });
  return rawToken;
}

function issueApiKey() {
  const key = `hyfib_${randomBytes(16).toString("hex")}`;
  apiKeys.set(hashApiKey(key), { id: randomUUID(), tenantId: TENANT_ID, name: "ci", roles: ["support_agent"] });
  return key;
}

const originals = [];

/**
 * Replaces `repository[method]`, counted and faulted under `name` ("sessions.findByToken", …). A fault set for
 * `name` wins: an Error is thrown, a function is asked (with the call's arguments) for the Error to throw, if any,
 * and REAL calls the original.
 */
function stub(name, repository, method, implementation) {
  const original = repository[method];
  originals.push([repository, method, original]);
  repository[method] = async (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    const fault = faults[name];
    if (fault === REAL) {
      return original.apply(repository, args);
    }
    const error = typeof fault === "function" ? fault(...args) : fault;
    if (error) {
      throw error;
    }
    return implementation(...args);
  };
}

function installStubs() {
  // The SQL filters on expires_at > now(); so does the stand-in.
  stub("sessions.findByToken", sessionRepository, "findByToken", async (hash) => {
    const session = sessions.get(hash);
    return session && Date.parse(session.expiresAt) > Date.now() ? { ...session } : undefined;
  });
  stub("sessions.create", sessionRepository, "create", async (input) => {
    const session = { id: randomUUID(), ...input, expiresAt: "", createdAt: "" };
    sessions.set(input.tokenHash, session);
    return session;
  });
  stub("sessions.deleteByToken", sessionRepository, "deleteByToken", async (hash) => {
    sessions.delete(hash);
  });
  stub("users.getById", userRepository, "getById", async (tenantId, id) => {
    const user = users.get(id);
    return user && user.tenantId === tenantId ? { ...user } : undefined;
  });
  stub("users.findByEmailForAuth", userRepository, "findByEmailForAuth", async (email) => {
    const user = [...users.values()].find((candidate) => candidate.email === email);
    return user ? { ...user, passwordHash: PASSWORD_HASH } : undefined;
  });
  stub("apiKeys.findActiveByHash", apiKeyRepository, "findActiveByHash", async (tenantId, keyHash) => {
    const key = apiKeys.get(keyHash);
    return key && key.tenantId === tenantId ? { ...key } : undefined;
  });
  stub("tenants.getById", tenantRepository, "getById", async (id) => ({
    id,
    name: "Test Org",
    status: "active",
    plan: "trial",
    maxUsers: 10,
    createdAt: new Date(0).toISOString()
  }));
  stub("tenants.getUserCount", tenantRepository, "getUserCount", async () => 1);
  stub("teams.list", teamRepository, "list", async () => []);
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

  faults = {};
  calls = {};
  installStubs();
  const gateway = createGatewayHandler({ eventBus: stubBus });
  // Resolves the organization (ORG_TENANT_ID) the API-key path authenticates against.
  await gateway.bootstrapPlatformAdmin();
  server = createServer((req, res) => {
    // Same fallback as the real hosts (standalone entrypoint, app-server): an error handle() lets escape is a 500.
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

beforeEach(() => {
  users.clear();
  sessions.clear();
  apiKeys.clear();
  faults = {};
  calls = {};
  users.set(USER_ID, {
    id: USER_ID,
    tenantId: TENANT_ID,
    email: EMAIL,
    displayName: "Agent",
    roles: ["support_agent"],
    status: "active"
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const bearer = (credential) => ({ "Content-Type": "application/json", Authorization: `Bearer ${credential}` });
const cookie = (rawToken) => ({
  "Content-Type": "application/json",
  Cookie: `hf_session=${rawToken}`,
  "x-requested-with": "fetch"
});

async function send(method, path, headers, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    body: parsed,
    setCookie: res.headers.get("set-cookie"),
    retryAfter: res.headers.get("retry-after"),
    contentType: res.headers.get("content-type")
  };
}

function assertStatus(response, expected, message) {
  assert.equal(
    response.status,
    expected,
    `${message}: expected ${expected}, got ${response.status} ${JSON.stringify(response.body)}`
  );
}

/** The 503 every auth-store outage gets: stable body, a Retry-After, and no cookie touched. */
function assertAuthUnavailable(response, message) {
  assertStatus(response, 503, message);
  assert.deepEqual(response.body, { error: "auth_unavailable", retryAfterSeconds: 5 }, `${message}: body`);
  assert.equal(response.retryAfter, "5", `${message}: Retry-After`);
  assert.equal(response.setCookie, null, `${message}: an outage must neither clear nor set the session cookie`);
}

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
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = write;
  }
  return { result, logs: lines.filter((line) => line.component === "api-gateway") };
}

function assertNoSecretIn(logs, secrets) {
  const text = JSON.stringify(logs);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), "a credential must never reach the log");
  }
}

async function counterValue(kind) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const line = text
    .split("\n")
    .find(
      (candidate) => candidate.startsWith("auth_backend_unavailable_total{") && candidate.includes(`kind="${kind}"`)
    );
  return line ? Number(line.trim().split(/\s+/).pop()) : 0;
}

// ─── Control ─────────────────────────────────────────────────────────────────

test("control: a live session authenticates by Bearer and by cookie, and a live API key authenticates", async () => {
  assertStatus(await send("GET", "/api/v1/teams", bearer(openSession())), 200, "Bearer session");
  assertStatus(await send("GET", "/api/v1/teams", cookie(openSession())), 200, "cookie session");
  assertStatus(await send("GET", "/api/v1/teams", bearer(issueApiKey())), 200, "API key");
});

// ─── An auth-store outage on an ordinary route is a 503 ─────────────────────

test("a session store that cannot be reached answers 503 auth_unavailable with Retry-After, not 401 (Bearer)", async () => {
  const token = openSession();
  faults["sessions.findByToken"] = connectionRefused();
  const before = await counterValue("bearer_session");
  const { result: res, logs } = await captureLogs(() => send("GET", "/api/v1/teams", bearer(token)));

  assertAuthUnavailable(res, "Bearer session, Postgres refusing connections");
  assert.equal(calls["teams.list"], undefined, "the route must not run for a request that was never authenticated");

  const line = logs.find((entry) => entry.message === "auth_backend_unavailable");
  assert.ok(line, `an auth_backend_unavailable line is logged (got ${logs.map((entry) => entry.message)})`);
  assert.equal(line.level, "error");
  assert.equal(line.path, "/api/v1/teams");
  assert.equal(line.method, "GET");
  assert.equal(line.authKind, "bearer_session");
  assert.equal(line.errorCode, "ECONNREFUSED");
  assert.match(line.error, /ECONNREFUSED/);
  assertNoSecretIn(logs, [token, tokenHash(token)]);
  assert.equal(await counterValue("bearer_session"), before + 1, "auth_backend_unavailable_total is counted");
});

test("a session store that cannot be reached answers 503 on the cookie path, and the cookie is left alone", async () => {
  const token = openSession();
  faults["sessions.findByToken"] = connectionRefused();
  const { result: res, logs } = await captureLogs(() => send("GET", "/api/v1/teams", cookie(token)));

  assertAuthUnavailable(res, "cookie session, Postgres refusing connections");
  const line = logs.find((entry) => entry.message === "auth_backend_unavailable");
  assert.equal(line?.authKind, "cookie_session");
  assertNoSecretIn(logs, [token, tokenHash(token)]);
});

test("with the real session repository and Postgres actually unreachable, the answer is 503", async () => {
  faults["sessions.findByToken"] = REAL;
  const { result: res, logs } = await captureLogs(() => send("GET", "/api/v1/teams", cookie(openSession())));
  assertAuthUnavailable(res, "real repository, nothing listening on the Postgres port");
  assert.equal(logs.find((entry) => entry.message === "auth_backend_unavailable")?.errorCode, "ECONNREFUSED");
});

test("every outage shape, at either lookup a session needs (the session, then its user), answers 503", async () => {
  for (const [shape, make] of Object.entries(OUTAGES)) {
    for (const lookup of ["sessions.findByToken", "users.getById"]) {
      for (const [how, headers] of [
        ["Bearer", bearer],
        ["cookie", cookie]
      ]) {
        faults = { [lookup]: make() };
        assertAuthUnavailable(
          await send("GET", "/api/v1/teams", headers(openSession())),
          `${shape} in ${lookup}, by ${how}`
        );
      }
    }
  }
});

test("the web app's event stream gets the 503 too, instead of a 401 that signs its user out", async () => {
  faults["sessions.findByToken"] = poolExhausted();
  const res = await send("GET", "/api/v1/events/stream", cookie(openSession()));
  assertAuthUnavailable(res, "event stream, pool exhausted");
  assert.match(res.contentType ?? "", /application\/json/, "no event stream was opened");
});

test("an API-key lookup that fails answers 503, and the key never reaches the log", async () => {
  const key = issueApiKey();
  faults["apiKeys.findActiveByHash"] = connectionRefused();
  const { result: res, logs } = await captureLogs(() => send("GET", "/api/v1/teams", bearer(key)));
  assertAuthUnavailable(res, "API key, Postgres refusing connections");
  assert.equal(logs.find((entry) => entry.message === "auth_backend_unavailable")?.authKind, "api_key");
  assertNoSecretIn(logs, [key, hashApiKey(key)]);
  assert.equal(
    calls["sessions.findByToken"],
    undefined,
    "a failed API-key lookup must not be retried as a session token"
  );
});

// ─── A 503 is a refusal: it never falls through ─────────────────────────────

test("a Bearer lookup that fails is not retried with the cookie: the request is refused, not authenticated", async () => {
  const bearerToken = openSession();
  const cookieToken = openSession();
  faults["sessions.findByToken"] = (hash) => (hash === tokenHash(bearerToken) ? connectionRefused() : undefined);
  const res = await send("GET", "/api/v1/teams", { ...bearer(bearerToken), Cookie: `hf_session=${cookieToken}` });
  assertAuthUnavailable(res, "failing Bearer beside a live cookie");
  assert.equal(calls["sessions.findByToken"], 1, "the cookie session must not be looked up");
  assert.equal(calls["teams.list"], undefined, "the route must not run");
});

test("a stale Bearer followed by a cookie whose lookup fails is a 503, not a Keycloak 401", async () => {
  const cookieToken = openSession();
  faults["sessions.findByToken"] = (hash) => (hash === tokenHash(cookieToken) ? adminShutdown() : undefined);
  const res = await send("GET", "/api/v1/teams", {
    ...bearer("stale-token-from-local-storage"),
    Cookie: `hf_session=${cookieToken}`,
    "x-requested-with": "fetch"
  });
  assertAuthUnavailable(res, "unknown Bearer, cookie lookup failing");
});

// ─── A refused credential is a 401, exactly as before ───────────────────────

test("an unknown, expired or revoked session is still a 401, by Bearer and by cookie", async () => {
  const expired = openSession(USER_ID, { expired: true });
  const revoked = openSession();
  sessions.delete(tokenHash(revoked));
  for (const [label, token] of [
    ["unknown", "not-a-session-token"],
    ["expired", expired],
    ["revoked", revoked]
  ]) {
    for (const [how, headers] of [
      ["Bearer", bearer],
      ["cookie", cookie]
    ]) {
      const res = await send("GET", "/api/v1/teams", headers(token));
      assertStatus(res, 401, `${label} session by ${how}`);
      assert.equal(res.body.error, "unauthenticated");
      assert.equal(res.retryAfter, null, `${label} session by ${how}: a refusal carries no Retry-After`);
    }
  }
  assertStatus(await send("GET", "/api/v1/teams", { "Content-Type": "application/json" }), 401, "no credential");
});

test("a session of a user who is not active is still a 401", async () => {
  users.get(USER_ID).status = "suspended";
  assertStatus(await send("GET", "/api/v1/teams", bearer(openSession())), 401, "suspended user by Bearer");
  assertStatus(await send("GET", "/api/v1/teams", cookie(openSession())), 401, "suspended user by cookie");
});

test("an unknown or revoked API key is still a 401", async () => {
  const res = await send("GET", "/api/v1/teams", bearer(`hyfib_${randomBytes(16).toString("hex")}`));
  assertStatus(res, 401, "unknown API key");
  assert.equal(res.body.error, "unauthenticated");
});

test("an error that is not recognisably an outage keeps today's 401, and is logged so it can be recognised", async () => {
  faults["sessions.findByToken"] = new TypeError("Cannot read properties of undefined (reading 'rows')");
  const token = openSession();
  const { result: res, logs } = await captureLogs(() => send("GET", "/api/v1/teams", bearer(token)));
  assertStatus(res, 401, "unrecognised error");
  assert.equal(res.body.error, "unauthenticated");
  const line = logs.find((entry) => entry.message === "auth_failure_unclassified");
  assert.ok(line, "an unrecognised failure is logged");
  assert.equal(line.errorName, "TypeError");
  assertNoSecretIn(logs, [token, tokenHash(token)]);
});

// ─── /auth/me ─────────────────────────────────────────────────────────────────

test("/auth/me answers 503 when the session store fails, and does not clear the cookie", async () => {
  for (const [label, lookup] of [
    ["the session", "sessions.findByToken"],
    ["its user", "users.getById"],
    ["its organization", "tenants.getById"]
  ]) {
    const token = openSession();
    faults = { [lookup]: connectionRefused() };
    const { result: byCookie, logs } = await captureLogs(() => send("GET", "/auth/me", cookie(token)));
    assertAuthUnavailable(byCookie, `/auth/me by cookie, ${label} unreachable`);
    const line = logs.find((entry) => entry.message === "auth_backend_unavailable");
    assert.equal(line?.path, "/auth/me");
    assertNoSecretIn(logs, [token, tokenHash(token)]);
    assert.ok(sessions.has(tokenHash(token)), "an outage must not revoke the session");

    // A Bearer-only caller would be issued a cookie on success (the silent upgrade); an outage issues nothing.
    assertAuthUnavailable(await send("GET", "/auth/me", bearer(token)), `/auth/me by Bearer, ${label} unreachable`);
  }
});

test("/auth/me still refuses an unknown session (401) and a suspended user's session (401, cookie cleared)", async () => {
  const unknown = await send("GET", "/auth/me", cookie("not-a-session-token"));
  assertStatus(unknown, 401, "unknown session");
  assert.equal(unknown.retryAfter, null);

  users.get(USER_ID).status = "suspended";
  const refused = await send("GET", "/auth/me", cookie(openSession()));
  assertStatus(refused, 401, "suspended user's session");
  assert.match(refused.setCookie ?? "", /hf_session=;/, "a genuine refusal still clears the cookie");

  users.get(USER_ID).status = "active";
  assertStatus(await send("GET", "/auth/me", cookie(openSession())), 200, "control: a live session");
});

// ─── /auth/login ──────────────────────────────────────────────────────────────

test("/auth/login answers 503 when the account store fails, the same whether or not the account exists", async () => {
  faults["users.findByEmailForAuth"] = connectionRefused();
  const { result: known, logs } = await captureLogs(() =>
    send("POST", "/auth/login", { "Content-Type": "application/json" }, { email: EMAIL, password: PASSWORD })
  );
  const unknown = await send(
    "POST",
    "/auth/login",
    { "Content-Type": "application/json" },
    { email: "nobody@example.com", password: "whatever-it-is" }
  );
  assertAuthUnavailable(known, "login, existing account, store unreachable");
  assertAuthUnavailable(unknown, "login, no such account, store unreachable");
  assert.deepEqual(known.body, unknown.body, "an outage must not reveal whether the account exists");
  const line = logs.find((entry) => entry.message === "auth_backend_unavailable");
  assert.equal(line?.path, "/auth/login");
  assert.equal(line?.authKind, "password");
  assertNoSecretIn(logs, [PASSWORD]);
});

test("/auth/login answers 503, and sets no cookie, when the store fails after the password is proven", async () => {
  for (const [label, fault] of [
    ["creating the session", { "sessions.create": poolExhausted() }],
    ["reading the organization", { "tenants.getById": adminShutdown() }]
  ]) {
    faults = fault;
    const res = await send(
      "POST",
      "/auth/login",
      { "Content-Type": "application/json" },
      { email: EMAIL, password: PASSWORD }
    );
    assertAuthUnavailable(res, `login, ${label} failing`);
  }
});

test("/auth/login still answers 401 for a wrong password or an unknown account, and 200 for the right one", async () => {
  const wrong = await send(
    "POST",
    "/auth/login",
    { "Content-Type": "application/json" },
    { email: EMAIL, password: "nope" }
  );
  assertStatus(wrong, 401, "wrong password");
  assert.equal(wrong.body.error, "Invalid email or password");
  const unknown = await send(
    "POST",
    "/auth/login",
    { "Content-Type": "application/json" },
    { email: "nobody@example.com", password: PASSWORD }
  );
  assertStatus(unknown, 401, "unknown account");
  assert.deepEqual(unknown.body, wrong.body);
  const ok = await send(
    "POST",
    "/auth/login",
    { "Content-Type": "application/json" },
    { email: EMAIL, password: PASSWORD }
  );
  assertStatus(ok, 200, "control: correct password");
});

test("/auth/login keeps today's 500 for an error that is not recognisably an outage", async () => {
  faults["users.findByEmailForAuth"] = new TypeError("Cannot read properties of undefined (reading 'rows')");
  const res = await send(
    "POST",
    "/auth/login",
    { "Content-Type": "application/json" },
    { email: EMAIL, password: PASSWORD }
  );
  assertStatus(res, 500, "unrecognised login failure");
});
