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
