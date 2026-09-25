import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SignJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair } from "jose";
import { AuthError, AuthUnavailableError, createAuthenticator } from "../dist/index.js";

const ISSUER = "https://idp.test/realms/hyfib-wa";
const AUDIENCE = "hyfib-platform";
const KID = "k1";

const signingKeys = await generateKeyPair("RS256");
const strangerKeys = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(signingKeys.publicKey)), kid: KID, alg: "RS256", use: "sig" };

/** A token as the realm would issue it; each option overrides one property to make it refusable. */
function sign({
  key = signingKeys.privateKey,
  kid = KID,
  issuer = ISSUER,
  audience = AUDIENCE,
  expiresAt = Math.floor(Date.now() / 1000) + 300
} = {}) {
  return new SignJWT({ tenant_id: "t1", email: "agent@example.test", realm_access: { roles: ["agent"] } })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("user-1")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key);
}

function configFor(jwksUri) {
  return { keycloak: { jwksUri, issuer: ISSUER, audience: AUDIENCE } };
}

function serveJwks(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ keys: [publicJwk] }));
}

/** A stand-in for Keycloak's certs endpoint, answering however `respond` does. */
async function startJwksServer(t, respond) {
  const server = createServer((req, res) => respond(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}/certs`;
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected authenticate() to reject");
}

/** A failure to check the token, as opposed to a refusal of it: never a 401 AuthError, and the cause is kept. */
function assertUnavailable(error, token) {
  assert.ok(
    error instanceof AuthUnavailableError,
    `expected AuthUnavailableError, got ${error?.name}: ${error?.message}`
  );
  assert.equal(error instanceof AuthError, false, "an outage must not be an AuthError, which callers answer with 401");
  assert.equal(error.name, "AuthUnavailableError");
  assert.ok(error.cause !== undefined, "the underlying failure is kept as the cause");
  assert.equal(error.message.includes(token), false, "the token is never put in the message");
}

test("a token the realm issued authenticates against its JWKS", async (t) => {
  const url = await startJwksServer(t, (_req, res) => serveJwks(res));
  const ctx = await createAuthenticator(configFor(url)).authenticate(`Bearer ${await sign()}`);

  assert.equal(ctx.subject, "user-1");
  assert.equal(ctx.tenantId, "t1");
  assert.equal(ctx.email, "agent@example.test");
  assert.deepEqual([...ctx.roles].sort(), ["sales_agent", "support_agent"]);
});

test("a refused token is still a 401 AuthError, with the same message as before", async (t) => {
  const url = await startJwksServer(t, (_req, res) => serveJwks(res));
  const cases = {
    expired: await sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
    "another issuer": await sign({ issuer: "https://elsewhere.test/realms/x" }),
    "another audience": await sign({ audience: "someone-else" }),
    "signed by a key the realm does not hold, under its key id": await sign({ key: strangerKeys.privateKey }),
    "signed under a key id the realm does not publish": await sign({ kid: "unknown-kid" }),
    "not a JWT at all": "not-a-jwt"
  };

  for (const [name, token] of Object.entries(cases)) {
    // A fresh authenticator per case, so each one starts with an empty key cache and fetches the JWKS itself.
    const error = await rejectionOf(createAuthenticator(configFor(url)).authenticate(`Bearer ${token}`));
    assert.ok(error instanceof AuthError, `${name}: expected AuthError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.status, 401, name);
    assert.equal(error instanceof AuthUnavailableError, false, name);
    assert.match(error.message, /^Invalid token: /, name);
  }
});

test("a missing or malformed Authorization header is refused without touching the JWKS", async () => {
  const authenticator = createAuthenticator(configFor("http://127.0.0.1:1/certs"));
  for (const header of [undefined, "", "Basic dXNlcjpwYXNz", "Bearer ", ["Token x"]]) {
    const error = await rejectionOf(authenticator.authenticate(header));
    assert.ok(error instanceof AuthError, `header ${JSON.stringify(header)}: got ${error?.name}`);
    assert.equal(error.status, 401);
  }
});

test("the realm's JWKS unreachable (connection refused) is AuthUnavailableError, not a refused token", async () => {
  const token = await sign();
  const error = await rejectionOf(
    createAuthenticator(configFor("http://127.0.0.1:1/certs")).authenticate(`Bearer ${token}`)
  );

  assertUnavailable(error, token);
  assert.equal(error.cause.code, "ECONNREFUSED");
});

test("the JWKS endpoint answering an error status is AuthUnavailableError", async (t) => {
  const url = await startJwksServer(t, (_req, res) => {
    res.writeHead(503);
    res.end("Service Unavailable");
  });
  const token = await sign();
  const error = await rejectionOf(createAuthenticator(configFor(url)).authenticate(`Bearer ${token}`));

  assertUnavailable(error, token);
  assert.equal(error.cause.message, "Expected 200 OK from the JSON Web Key Set HTTP response");
});

test("the JWKS endpoint answering an error page with 200 is AuthUnavailableError", async (t) => {
  const url = await startJwksServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>Bad gateway</body></html>");
  });
  const token = await sign();
  const error = await rejectionOf(createAuthenticator(configFor(url)).authenticate(`Bearer ${token}`));

  assertUnavailable(error, token);
  assert.equal(error.cause.message, "Failed to parse the JSON Web Key Set HTTP response as JSON");
});

test("the JWKS endpoint answering JSON that is not a key set is AuthUnavailableError", async (t) => {
  const url = await startJwksServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "realm not found" }));
  });
  const token = await sign();
  const error = await rejectionOf(createAuthenticator(configFor(url)).authenticate(`Bearer ${token}`));

  assertUnavailable(error, token);
  assert.equal(error.cause.code, "ERR_JWKS_INVALID");
});

test("a JWKS fetch that times out is AuthUnavailableError", async () => {
  const token = await sign();
  const timeout = new errors.JWKSTimeout();
  const authenticator = createAuthenticator(configFor("http://127.0.0.1:1/certs"), {
    keySet: async () => {
      throw timeout;
    }
  });
  const error = await rejectionOf(authenticator.authenticate(`Bearer ${token}`));

  assertUnavailable(error, token);
  assert.equal(error.cause, timeout);
});

test("an error that is not a verdict on the token is AuthUnavailableError carrying it, for the caller to classify", async () => {
  const token = await sign();
  const bug = new TypeError("something unexpected");
  const authenticator = createAuthenticator(configFor("http://127.0.0.1:1/certs"), {
    keySet: async () => {
      throw bug;
    }
  });
  const error = await rejectionOf(authenticator.authenticate(`Bearer ${token}`));

  assertUnavailable(error, token);
  assert.equal(error.cause, bug);
});

test("an injected key set is used instead of the realm's remote JWKS", async () => {
  const authenticator = createAuthenticator(configFor("http://127.0.0.1:1/certs"), {
    keySet: createLocalJWKSet({ keys: [publicJwk] })
  });
  const ctx = await authenticator.authenticate(`Bearer ${await sign()}`);

  assert.equal(ctx.subject, "user-1");
});

test("once the JWKS endpoint recovers, the same token is accepted: the outage was not the token's fault", async (t) => {
  let down = true;
  const url = await startJwksServer(t, (_req, res) => {
    if (down) {
      res.writeHead(503);
      res.end();
      return;
    }
    serveJwks(res);
  });
  const authenticator = createAuthenticator(configFor(url));
  const token = await sign();

  assertUnavailable(await rejectionOf(authenticator.authenticate(`Bearer ${token}`)), token);
  down = false;
  const ctx = await authenticator.authenticate(`Bearer ${token}`);
  assert.equal(ctx.subject, "user-1");
});

// ─── Riding out a Keycloak outage on the last keys the realm served ─────────────────────────────────────────

const strangerJwk = { ...(await exportJWK(strangerKeys.publicKey)), kid: "k2", alg: "RS256", use: "sig" };

/** A JWKS stand-in a test takes down and brings back: `mode` says how it answers, `keys` what it publishes. */
async function startRealm(t) {
  const realm = { mode: "keys", keys: [publicJwk], requests: 0 };
  const server = createServer((req, res) => {
    realm.requests += 1;
    switch (realm.mode) {
      case "keys":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: realm.keys }));
        return;
      case "error_page":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>502 Bad Gateway</body></html>");
        return;
      case "not_a_key_set":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Realm does not exist" }));
        return;
      case "dropped":
        req.socket.destroy();
        return;
      case "hang":
        return; // never answers: the fetch times out
      default:
        res.writeHead(503);
        res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  realm.url = `http://127.0.0.1:${server.address().port}/certs`;
  /** Keycloak down: connections to it are refused from now on. */
  realm.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  t.after(realm.stop);
  return realm;
}

/** A clock a test moves forward; the stale-key limits are measured on it. */
function testClock() {
  const clock = { offsetMs: 0, now: () => Date.now() + clock.offsetMs, advance: (ms) => (clock.offsetMs += ms) };
  return clock;
}

function recordingLogger() {
  const lines = [];
  const record =
    (level) =>
    (message, metadata = {}) =>
      lines.push({ level, message, ...metadata });
  return {
    lines,
    named: (message) => lines.filter((line) => line.message === message),
    info: record("info"),
    warn: record("warn"),
    error: record("error")
  };
}

/**
 * An authenticator for `realm` whose key cache is always expired (jose's cacheMaxAge 0), so every token asks the
 * realm: the state ten minutes into an outage, without the wait.
 */
function outageReadyAuthenticator(realm, { clock = testClock(), logger = recordingLogger(), ...realmKeySet } = {}) {
  const authenticator = createAuthenticator(configFor(realm.url), {
    realmKeySet: { remote: { cacheMaxAge: 0, timeoutDuration: 200 }, now: clock.now, logger, ...realmKeySet }
  });
  return { clock, logger, verify: (token) => authenticator.authenticate(`Bearer ${token}`) };
}

async function until(condition, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("ten minutes into a Keycloak outage, a token the realm signed still verifies, on the last keys it served", async (t) => {
  for (const [mode, label] of [
    ["error_status", "the JWKS endpoint answers an error status"],
    ["error_page", "the JWKS endpoint answers an HTML error page with 200"],
    ["not_a_key_set", "the JWKS endpoint serves JSON that is not a key set"],
    ["dropped", "the connection is dropped"],
    ["hang", "the JWKS endpoint does not answer (the fetch times out)"],
    ["refused", "Keycloak is down (connection refused)"]
  ]) {
    const realm = await startRealm(t);
    const { verify, logger } = outageReadyAuthenticator(realm);
    const token = await sign();
    assert.equal((await verify(token)).subject, "user-1", `${label}: control, the realm is up`);

    if (mode === "refused") {
      await realm.stop();
    } else {
      realm.mode = mode;
    }
    assert.equal((await verify(token)).subject, "user-1", `${label}: verified on the last good keys`);

    const lines = logger.named("keycloak_jwks_unavailable");
    assert.equal(lines.length, 1, `${label}: the outage is logged once`);
    assert.equal(lines[0].level, "warn", label);
    assert.equal(lines[0].fallback, "last_good_keys", label);
    assert.match(lines[0].lastFetchedAt, /^\d{4}-\d\d-\d\dT/, `${label}: when the keys in use were fetched`);
  }
});

test("during an outage, the last good keys still refuse what they should: a forged signature, an expired token", async (t) => {
  const realm = await startRealm(t);
  const { verify } = outageReadyAuthenticator(realm);
  await verify(await sign());
  realm.mode = "error_status";

  for (const [label, token] of [
    ["signed by a key the realm does not hold, under its key id", await sign({ key: strangerKeys.privateKey })],
    ["expired", await sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
    ["another audience", await sign({ audience: "someone-else" })]
  ]) {
    const error = await rejectionOf(verify(token));
    assert.ok(error instanceof AuthError, `${label}: expected AuthError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.status, 401, label);
  }
});

test("during an outage, a token naming a key id the last good set does not hold is unavailable, not refused", async (t) => {
  // The realm may have published that key since it was last reachable; while it is not, that cannot be known.
  const realm = await startRealm(t);
  const { verify } = outageReadyAuthenticator(realm);
  await verify(await sign());
  realm.mode = "error_status";

  const token = await sign({ key: strangerKeys.privateKey, kid: "k2" });
  const error = await rejectionOf(verify(token));
  assertUnavailable(error, token);
  assert.equal(error.cause.message, "Expected 200 OK from the JSON Web Key Set HTTP response");
});

test("the last good keys are used for less than maxStaleMs after they were fetched; then an outage is an outage", async (t) => {
  const realm = await startRealm(t);
  const { verify, clock, logger } = outageReadyAuthenticator(realm, { maxStaleMs: 60 * 60 * 1000 });
  const token = await sign();
  await verify(token);
  realm.mode = "error_status";

  clock.advance(59 * 60 * 1000);
  assert.equal((await verify(token)).subject, "user-1", "59 minutes after the last successful fetch");

  clock.advance(2 * 60 * 1000);
  assertUnavailable(await rejectionOf(verify(token)), token);
  assertUnavailable(await rejectionOf(verify(token)), token);
  const expired = logger.named("keycloak_jwks_last_good_keys_expired");
  assert.equal(expired.length, 1, "logged once when the keys run out, not per request");
  assert.equal(expired[0].level, "error");
});

test("maxStaleMs 0 turns the fallback off: an outage is unavailable at once", async (t) => {
  const realm = await startRealm(t);
  const { verify, logger } = outageReadyAuthenticator(realm, { maxStaleMs: 0 });
  const token = await sign();
  await verify(token);
  realm.mode = "error_status";

  assertUnavailable(await rejectionOf(verify(token)), token);
  assert.equal(logger.named("keycloak_jwks_unavailable")[0]?.fallback, "none");
});

test("with no key set fetched yet, an outage is unavailable, as before, and logged as having nothing to fall back on", async (t) => {
  const realm = await startRealm(t);
  realm.mode = "error_status";
  const { verify, logger } = outageReadyAuthenticator(realm);
  const token = await sign();

  assertUnavailable(await rejectionOf(verify(token)), token);
  const [line] = logger.named("keycloak_jwks_unavailable");
  assert.equal(line?.fallback, "none");
  assert.equal(line?.lastFetchedAt, null);
});

test("during an outage, tokens do not wait on the realm: it is asked again once per retry interval, in the background", async (t) => {
  const realm = await startRealm(t);
  const { verify, clock, logger } = outageReadyAuthenticator(realm, { retryIntervalMs: 30_000 });
  const token = await sign();
  await verify(token);
  assert.equal(realm.requests, 1, "control: the first token fetched the key set");

  realm.mode = "error_status";
  await verify(token);
  assert.equal(realm.requests, 2, "the failed refresh that started the outage");
  for (let i = 0; i < 5; i += 1) {
    await verify(token);
  }
  assert.equal(realm.requests, 2, "within the retry interval, tokens are verified without asking the realm");

  clock.advance(30_000);
  await verify(token);
  await until(() => realm.requests === 3, "the background retry");
  for (let i = 0; i < 5; i += 1) {
    await verify(token);
  }
  assert.equal(realm.requests, 3, "one retry per interval, however many tokens arrive");
  assert.equal(logger.named("keycloak_jwks_unavailable").length, 1, "the outage is logged once, not per request");
});

test("during an outage, a realm that hangs does not hold tokens up: the retry waits in the background", async (t) => {
  const realm = await startRealm(t);
  const { verify, clock } = outageReadyAuthenticator(realm, { remote: { cacheMaxAge: 0, timeoutDuration: 60_000 } });
  const token = await sign();
  await verify(token);
  realm.mode = "error_status";
  await verify(token);

  realm.mode = "hang";
  clock.advance(30_000);
  assert.equal((await verify(token)).subject, "user-1", "verified at once on the last good keys");
  await until(() => realm.requests === 3, "the background retry to reach the realm");
  assert.equal((await verify(token)).subject, "user-1", "still verified while the retry hangs");
});

test("when the realm answers again the outage ends, and its current keys apply: a key it dropped is refused", async (t) => {
  const realm = await startRealm(t);
  const { verify, clock, logger } = outageReadyAuthenticator(realm);
  const oldKeyToken = await sign();
  await verify(oldKeyToken);
  realm.mode = "error_status";
  assert.equal((await verify(oldKeyToken)).subject, "user-1", "during the outage, on the last good keys");

  // The realm comes back having rotated its key: k1 is withdrawn, k2 is current.
  realm.keys = [strangerJwk];
  realm.mode = "keys";
  clock.advance(30_000);
  await verify(oldKeyToken);
  await until(() => logger.named("keycloak_jwks_recovered").length === 1, "the outage to end");
  assert.equal(logger.named("keycloak_jwks_recovered")[0].level, "info");

  const error = await rejectionOf(verify(oldKeyToken));
  assert.ok(error instanceof AuthError, `a withdrawn key is refused once the realm answers, got ${error?.name}`);
  assert.equal(error.status, 401);
  const newKeyToken = await sign({ key: strangerKeys.privateKey, kid: "k2" });
  assert.equal((await verify(newKeyToken)).subject, "user-1", "the realm's current key is accepted");
});

test("a realm that answers is never overridden by the last good keys: a key it stopped publishing is refused", async (t) => {
  const realm = await startRealm(t);
  const { verify, logger } = outageReadyAuthenticator(realm);
  const token = await sign();
  await verify(token);

  realm.keys = [strangerJwk];
  const error = await rejectionOf(verify(token));
  assert.ok(error instanceof AuthError, `got ${error?.name}: ${error?.message}`);
  assert.equal(error.status, 401);
  assert.equal(logger.lines.length, 0, "the realm answered: no outage, nothing logged");
});
