import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { AuthError, AuthUnavailableError } from "@hyfib/auth";
import {
  AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
  classifyAuthFailure,
  summarizeAuthFailure
} from "../dist/auth-failure.js";

/**
 * Deciding whether a failed authentication is the caller's credential (401: sign in again) or the gateway's own
 * backend (503: try again shortly). Every error resolveAuth let through used to become a 401, so a Postgres blip
 * told every client its session was gone, and the web app signed its user out.
 *
 * The errors below are, wherever possible, the real thing: a refused TCP connection, the pg driver's own
 * DatabaseError class, and jose's own error classes produced by actually verifying bad tokens (loaded from the
 * @hyfib/auth package, which is where the gateway's token verification comes from). Nothing here reaches a real
 * server: every connection goes to 127.0.0.1:1, where nothing listens.
 */

const requireFromAuth = createRequire(new URL("../../../packages/auth/package.json", import.meta.url));
const requireFromPersistence = createRequire(new URL("../../../packages/persistence/package.json", import.meta.url));
const jose = requireFromAuth("jose");
const pg = requireFromPersistence("pg");

/** An Error carrying a Node system-error code, as net/dns/http raise them. */
function systemError(code, message = `connect ${code} 10.0.0.5:5432`) {
  return Object.assign(new Error(message), { code, errno: -1, syscall: "connect" });
}

/** The pg driver's own error for a server-reported failure, with its SQLSTATE. */
function databaseError(code, message = `server error ${code}`) {
  const error = new pg.DatabaseError(message, message.length, "error");
  error.code = code;
  error.severity = "FATAL";
  return error;
}

// ─── Infrastructure: the gateway could not ask ─────────────────────────────

test("a genuinely refused TCP connection is an outage, not a bad credential", async () => {
  const refused = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 1 });
    socket.on("error", resolve);
  });
  assert.equal(refused.code, "ECONNREFUSED", "control: port 1 refuses");
  assert.equal(classifyAuthFailure(refused), "unavailable");
});

test("the pg driver's own error for an unreachable database is an outage", async () => {
  const pool = new pg.Pool({ host: "127.0.0.1", port: 1, user: "nobody", database: "nothing", password: "x" });
  pool.on("error", () => {});
  const error = await pool.query("SELECT 1").then(
    () => assert.fail("nothing listens on port 1"),
    (caught) => caught
  );
  await pool.end();
  assert.equal(classifyAuthFailure(error), "unavailable", `${error.name}: ${error.message}`);
});

test("every network failure code is an outage", () => {
  for (const code of [
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "EHOSTDOWN",
    "ENETUNREACH",
    "ENETDOWN",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EADDRNOTAVAIL",
    // undici (global fetch): a JWKS or other HTTP dependency fetched with fetch().
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CLOSED"
  ]) {
    assert.equal(classifyAuthFailure(systemError(code)), "unavailable", code);
  }
});

test("the pg driver's connection and pool failures, which carry no code, are outages", () => {
  for (const message of [
    // pg-pool: every client busy for connectionTimeoutMillis (pool exhausted), or a new connection too slow.
    "timeout exceeded when trying to connect",
    "Connection terminated due to connection timeout",
    // pg client: the server went away mid-query, or the client is already broken or closed.
    "Connection terminated unexpectedly",
    "Connection terminated",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
    "Query read timeout",
    "timeout expired",
    // pg-pool during shutdown.
    "Cannot use a pool after calling end on the pool"
  ]) {
    assert.equal(classifyAuthFailure(new Error(message)), "unavailable", message);
  }
});

test("pg-pool's connection-timeout error is recognised with the cause it wraps", () => {
  const error = new Error("Connection terminated due to connection timeout", { cause: new Error("timeout expired") });
  assert.equal(classifyAuthFailure(error), "unavailable");
});

test("server-reported SQLSTATEs that mean the database is down, overloaded or failing over are outages", () => {
  for (const code of [
    // Class 08: connection exception.
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08P01",
    // Class 53: insufficient resources (too_many_connections, out_of_memory, disk_full, …).
    "53000",
    "53100",
    "53200",
    "53300",
    "53400",
    // Operator intervention: shutdown, crash, starting up; statement_timeout / cancel.
    "57P01",
    "57P02",
    "57P03",
    "57014",
    // Class 58: system error (I/O).
    "58000",
    "58030",
    // Transient concurrency failures: retrying succeeds.
    "40001",
    "40P01",
    "55P03",
    // A write reached a read-only node, as after a failover.
    "25006",
    // Class 28: the GATEWAY's own database login was rejected (e.g. after a password rotation or a pg_hba change).
    // It is never a user's credential — users authenticate against rows, not database roles.
    "28000",
    "28P01",
    // The database the gateway connects to does not exist (a misconfiguration or a restore in progress).
    "3D000"
  ]) {
    assert.equal(classifyAuthFailure(databaseError(code)), "unavailable", `SQLSTATE ${code}`);
  }
});

test("an outage wrapped by another error, or reported as one of several attempts, is still an outage", () => {
  assert.equal(
    classifyAuthFailure(new Error("session lookup failed", { cause: systemError("ECONNRESET") })),
    "unavailable",
    "a cause chain"
  );
  assert.equal(
    classifyAuthFailure(new TypeError("fetch failed", { cause: systemError("ECONNREFUSED") })),
    "unavailable",
    "undici's fetch failure, whose cause carries the code"
  );
  assert.equal(
    classifyAuthFailure(new AggregateError([systemError("ECONNREFUSED"), systemError("ETIMEDOUT")], "")),
    "unavailable",
    "Node's happy-eyeballs AggregateError, one error per address tried"
  );
  assert.equal(
    classifyAuthFailure(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    "unavailable",
    "AbortSignal.timeout() expiring on a fetch"
  );
});

test("failing to fetch the identity provider's signing keys (JWKS) is an outage, not a bad token", async () => {
  const { privateKey } = await jose.generateKeyPair("ES256");
  const token = await new jose.SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject("u").sign(privateKey);
  const refused = await jose.jwtVerify(token, jose.createRemoteJWKSet(new URL("http://127.0.0.1:1/certs"))).then(
    () => assert.fail("nothing listens on port 1"),
    (caught) => caught
  );
  assert.equal(classifyAuthFailure(refused), "unavailable", `jose on an unreachable JWKS: ${refused.message}`);

  assert.equal(classifyAuthFailure(new jose.errors.JWKSTimeout()), "unavailable", "jose's JWKS timeout");
  assert.equal(
    classifyAuthFailure(new jose.errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response")),
    "unavailable",
    "the JWKS endpoint answered with an error status"
  );
  assert.equal(
    classifyAuthFailure(new jose.errors.JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON")),
    "unavailable",
    "the JWKS endpoint answered with something that is not a key set (an error page)"
  );
});

test("a key set the realm serves that jose cannot use is an outage: the realm's misconfiguration, never the token's", async () => {
  // JSON that is not a key set at all: a proxy's JSON error body behind a 200, or a JWKS URI pointing elsewhere.
  let notAKeySet;
  try {
    jose.createLocalJWKSet({ error: "Realm does not exist" });
  } catch (caught) {
    notAKeySet = caught;
  }
  assert.equal(notAKeySet?.code, "ERR_JWKS_INVALID", "jose accepts only a key set");
  assert.equal(classifyAuthFailure(notAKeySet), "unavailable", `jose on a non-key-set: ${notAKeySet.message}`);

  // A key set publishing a private key (the realm exposing a key's private half by mistake): a token's header can
  // select that key, but only the realm put it there. Still a refusal either way; 503 only says a new sign-in will
  // not help.
  const { privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const token = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "p1" })
    .setSubject("u")
    .sign(privateKey);
  const privateKeySet = jose.createLocalJWKSet({ keys: [{ ...(await jose.exportJWK(privateKey)), kid: "p1" }] });
  const privateInSet = await jose.jwtVerify(token, privateKeySet).then(
    () => assert.fail("jose refuses a key set member that is not a public key"),
    (caught) => caught
  );
  assert.equal(privateInSet.code, "ERR_JWKS_INVALID", privateInSet.message);
  assert.equal(classifyAuthFailure(privateInSet), "unavailable", privateInSet.message);

  // As the authenticator (packages/auth) reports it: an AuthUnavailableError with jose's error as its cause.
  const reported = new AuthUnavailableError(`Token could not be verified: ${notAKeySet.message}`, {
    cause: notAKeySet
  });
  assert.equal(classifyAuthFailure(reported), "unavailable", "wrapped by the authenticator");
  assert.equal(summarizeAuthFailure(reported).code, "ERR_JWKS_INVALID", "the log line names jose's code");
});

// ─── Credential: the gateway asked, and the answer was no ──────────────────

test("an AuthError is a refusal made on purpose, and stays a credential failure whatever caused it", () => {
  for (const message of [
    "Invalid or revoked API key",
    "Missing or malformed Authorization header",
    "Empty bearer token",
    "Token missing subject",
    "account_suspended",
    "account_disabled",
    "account_invited",
    "account_not_found"
  ]) {
    assert.equal(classifyAuthFailure(new AuthError(message, 401)), "credential", message);
  }
  const wrapped = new AuthError("Invalid token: connect ECONNREFUSED 10.0.0.5:8080");
  wrapped.cause = systemError("ECONNREFUSED");
  assert.equal(classifyAuthFailure(wrapped), "credential", "the refusal decides, not what it wraps");
});

test("jose's own verdicts on a token are credential failures, though none of them is an AuthError", async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
  const stranger = await jose.generateKeyPair("ES256");
  const sign = (build) =>
    build(new jose.SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject("u")).sign(privateKey);
  const expired = await sign((jwt) => jwt.setIssuedAt(1_000).setExpirationTime(2_000));
  const current = await sign((jwt) => jwt.setIssuedAt().setExpirationTime("1h").setAudience("hyfib-platform"));

  const verdicts = {
    expired: () => jose.jwtVerify(expired, publicKey),
    "signed by another key": () => jose.jwtVerify(current, stranger.publicKey),
    "wrong audience": () => jose.jwtVerify(current, publicKey, { audience: "someone-else" }),
    "wrong issuer": () => jose.jwtVerify(current, publicKey, { issuer: "https://idp.example/realms/other" }),
    "not a JWT at all": () => jose.jwtVerify("not-a-jwt", publicKey),
    "an algorithm that is not allowed": () => jose.jwtVerify(current, publicKey, { algorithms: ["RS256"] }),
    "no key in the set matches": () => jose.jwtVerify(current, jose.createLocalJWKSet({ keys: [] }))
  };
  for (const [label, verify] of Object.entries(verdicts)) {
    const error = await verify().then(
      () => assert.fail(`${label} must not verify`),
      (caught) => caught
    );
    assert.ok(!(error instanceof AuthError), `control: jose raises its own class for ${label}`);
    assert.equal(classifyAuthFailure(error), "credential", `${label} (${error.code})`);
  }

  for (const JoseError of [
    jose.errors.JWTExpired,
    jose.errors.JWTClaimValidationFailed,
    jose.errors.JWSSignatureVerificationFailed,
    jose.errors.JWSInvalid,
    jose.errors.JWTInvalid,
    jose.errors.JWKInvalid,
    jose.errors.JWKSNoMatchingKey,
    jose.errors.JWKSMultipleMatchingKeys,
    jose.errors.JOSEAlgNotAllowed,
    jose.errors.JOSENotSupported,
    jose.errors.JWEInvalid,
    jose.errors.JWEDecryptionFailed
  ]) {
    // The second argument is the claims payload for the two claim errors and plain options for the rest.
    assert.equal(classifyAuthFailure(new JoseError("rejected", {})), "credential", JoseError.name);
  }
});

test("a credential failure wrapped by another error is still a credential failure", () => {
  const expired = new jose.errors.JWTExpired('"exp" claim timestamp check failed', {});
  assert.equal(classifyAuthFailure(new Error("verification failed", { cause: expired })), "credential");
});

// ─── Anything else: today's answer, a 401 ──────────────────────────────────

test("an error that cannot be positively identified as an outage keeps today's answer (a credential failure)", () => {
  for (const [label, error] of [
    ["a plain Error", new Error("something odd")],
    ["a programming error", new TypeError("Cannot read properties of undefined (reading 'tenantId')")],
    ["bad SQL input", databaseError("22P02", 'invalid input syntax for type uuid: "x"')],
    ["a missing table", databaseError("42P01", 'relation "sessions" does not exist')],
    ["a permission problem", databaseError("42501", "permission denied for table sessions")],
    ["an unknown code", systemError("ESOMETHINGNEW")],
    ["another JOSE failure", new jose.errors.JOSEError("something else")],
    ["a fetch failure with no cause", new TypeError("fetch failed")],
    ["an abort that is not a timeout", new DOMException("This operation was aborted", "AbortError")],
    ["a string", "ECONNREFUSED"],
    ["undefined", undefined],
    ["null", null],
    ["an object with a code but no message", { code: "ECONNREFUSED_NOT" }]
  ]) {
    assert.equal(classifyAuthFailure(error), "credential", label);
  }
});

test("a cause chain that loops back on itself terminates", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  assert.equal(classifyAuthFailure(first), "credential");
  const outage = new Error("outer", { cause: systemError("ECONNREFUSED") });
  outage.cause.cause = outage;
  assert.equal(classifyAuthFailure(outage), "unavailable");
});

// ─── The log line ───────────────────────────────────────────────────────────

test("the log summary names the error and its code, and leaves out what pg attaches beyond the message", () => {
  const error = databaseError("57P01", "terminating connection due to administrator command");
  error.detail = "Key (token_hash)=(0123456789abcdef) is sensitive";
  error.where = "SQL statement";
  const summary = summarizeAuthFailure(error);
  assert.deepEqual(summary, {
    name: "error",
    code: "57P01",
    message: "terminating connection due to administrator command"
  });
  assert.ok(!JSON.stringify(summary).includes("0123456789abcdef"), "the pg detail must not be logged");
});

test("the log summary finds the code on a cause when the outer error has none, and bounds the message", () => {
  assert.deepEqual(summarizeAuthFailure(new TypeError("fetch failed", { cause: systemError("EAI_AGAIN") })), {
    name: "TypeError",
    code: "EAI_AGAIN",
    message: "fetch failed"
  });
  const long = summarizeAuthFailure(new Error("x".repeat(5_000)));
  assert.ok(long.message.length <= 300, `message bounded, got ${long.message.length} characters`);
  assert.deepEqual(summarizeAuthFailure("not an error"), { name: "unknown", code: undefined, message: "not an error" });
});

test("a client is told to retry after a few seconds", () => {
  assert.equal(AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS, 5);
});
