/**
 * Why authenticating a request failed: the caller's credential, or the gateway's own backend. Pure, no I/O — the
 * request handler (index.ts) owns the response, the log line and the metric; this module only decides which of the
 * two a thrown error is.
 *
 * The two need different answers. A refused credential (missing, malformed, unknown, expired, revoked, bad signature,
 * wrong audience or issuer, a user who is not active) is a 401: the client must sign in again, and retrying the same
 * credential can never succeed. A backend the gateway could not ask (Postgres down, restarting, out of connections,
 * the pool exhausted, the identity provider's signing keys unreachable) is a 503: nothing is wrong with the
 * credential, and the same request will succeed once the backend is back. Answering that with a 401, as every error
 * but an AuthError used to be, told clients their session was gone, and the web app signed its user out on a blip.
 *
 * The classification is by positive identification, not "anything that is not an AuthError": an error is an outage
 * only if it (or an error in its cause chain) matches one of the known infrastructure shapes below. Anything else —
 * an AuthError, a token library's verdict, or an error nobody recognises — is a credential failure, which is what
 * every one of them was answered as before. That default is deliberate. Authentication fails closed either way (the
 * request is refused), so the choice is only which refusal: a 503 for an unrecognised error would make a client retry
 * forever against what may be a credential or a bug that no retry fixes (an expired token, retried every 5 seconds,
 * never recovers), while a 401 keeps today's behaviour and costs, at worst, a sign-in. The handler logs every
 * unrecognised error, so a new outage shape can be spotted and added to the list here.
 */

import { AuthError } from "@hyfib/auth";

export type AuthFailureKind = "credential" | "unavailable";

/** The Retry-After, in seconds, a 503 auth_unavailable carries: long enough not to hammer a recovering database. */
export const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Node system-error codes (net, dns, http) for a dependency that could not be reached or dropped the connection,
 * plus undici's (global fetch) equivalents. pg raises these as-is when Postgres is down; jose's JWKS fetch
 * (createRemoteJWKSet) raises them as-is when the identity provider is.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
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
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED"
]);

/**
 * PostgreSQL SQLSTATE classes that are all about the server's state, never the query: 08 connection exception,
 * 53 insufficient resources (too_many_connections, out_of_memory, disk_full), 58 system error (I/O), and 28 invalid
 * authorization specification — which here is always the GATEWAY's own database login being rejected (after a
 * password rotation or a pg_hba change), never a user's credential: users authenticate against rows, not roles.
 * Answering that with 401 would sign every user out over a server-side misconfiguration.
 */
const TRANSIENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["08", "28", "53", "58"]);

/** Individual SQLSTATEs that mean "not now" rather than "no". */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up, recovering)
  "57014", // query_canceled (statement_timeout)
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "25006", // read_only_sql_transaction (reached a replica, as after a failover)
  "3D000" // invalid_catalog_name: the gateway's database does not exist (misconfiguration, restore in progress)
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Messages of errors that carry no code: the pg driver's and pg-pool's own connection failures (exact text, as the
 * pinned pg 8.13 / pg-pool 3.14 raise them), and jose's failures to fetch a JSON Web Key Set.
 */
const INFRASTRUCTURE_MESSAGES: ReadonlySet<string> = new Set([
  "timeout exceeded when trying to connect", // pg-pool: no client free within connectionTimeoutMillis
  "Connection terminated due to connection timeout", // pg-pool: a new connection took too long
  "Connection terminated unexpectedly", // pg: the server closed the connection
  "Connection terminated", // pg: the client was ended under a query
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
  "Query read timeout", // pg: query_timeout
  "timeout expired", // pg: connect timeout (the cause pg-pool wraps)
  "Cannot use a pool after calling end on the pool", // pg-pool: shutting down
  "Expected 200 OK from the JSON Web Key Set HTTP response", // jose: the JWKS endpoint answered with an error
  "Failed to parse the JSON Web Key Set HTTP response as JSON" // jose: it answered with an error page
]);

/** jose's code for a JWKS fetch that timed out (JWKSTimeout). */
const JWKS_TIMEOUT_CODE = "ERR_JWKS_TIMEOUT";

/**
 * jose's codes for its verdicts on a token. None of these errors is an AuthError, and each means the token itself was
 * refused: expired, badly signed, for another audience or issuer, malformed, or signed with a key or algorithm this
 * deployment does not accept. They are credential failures whatever an error wrapping them looks like.
 */
const JOSE_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JWK_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWE_INVALID",
  "ERR_JWE_DECRYPTION_FAILED"
]);

/** How far down a cause chain to look. Real chains are one or two deep; the bound only guards against a cycle. */
const MAX_CHAIN_LENGTH = 8;

const MAX_LOGGED_MESSAGE_LENGTH = 300;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** The error, then each error it was caused by (and, for an AggregateError, each error it aggregates), once each. */
function* errorChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < MAX_CHAIN_LENGTH) {
    const link = queue.shift();
    if (link === undefined || link === null || seen.has(link)) {
      continue;
    }
    seen.add(link);
    yield link;
    if (link instanceof AggregateError) {
      queue.push(...(link.errors as unknown[]));
    }
    if (link instanceof Error && link.cause !== undefined) {
      queue.push(link.cause);
    }
  }
}

/** A refusal made on purpose (AuthError), or a token library's verdict on the credential. */
function isCredentialFailure(error: unknown): boolean {
  if (error instanceof AuthError) {
    return true;
  }
  const code = codeOf(error);
  return code !== undefined && JOSE_CREDENTIAL_CODES.has(code);
}

/** A backend the gateway could not ask, or that could not answer. */
function isInfrastructureFailure(error: unknown): boolean {
  const code = codeOf(error);
  if (code !== undefined) {
    if (NETWORK_ERROR_CODES.has(code) || code === JWKS_TIMEOUT_CODE) {
      return true;
    }
    if (SQLSTATE.test(code) && (TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2)) || TRANSIENT_SQLSTATES.has(code))) {
      return true;
    }
  }
  // AbortSignal.timeout() expiring on a fetch.
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  const message = messageOf(error);
  return message !== undefined && INFRASTRUCTURE_MESSAGES.has(message);
}

/**
 * "unavailable" if `error` is positively identified as an infrastructure failure, "credential" otherwise. The nearest
 * recognised error in the cause chain decides, and an AuthError (or a jose verdict) decides "credential" even if it
 * wraps an outage: the code that threw it chose to refuse.
 */
export function classifyAuthFailure(error: unknown): AuthFailureKind {
  for (const link of errorChain(error)) {
    if (isCredentialFailure(link)) {
      return "credential";
    }
    if (isInfrastructureFailure(link)) {
      return "unavailable";
    }
  }
  return "credential";
}

export interface AuthFailureSummary {
  name: string;
  /** The first code found down the cause chain (a system-error code, a SQLSTATE, a jose code). */
  code: string | undefined;
  /** The outer error's message, bounded. */
  message: string;
}

/**
 * What to log about an auth failure: the error's name, a code and a bounded message — never the credential, which no
 * repository or verifier receives in the clear, and never what pg attaches beyond the message (detail, where,
 * parameters), which can quote the values a query was run with.
 */
export function summarizeAuthFailure(error: unknown): AuthFailureSummary {
  let code: string | undefined;
  for (const link of errorChain(error)) {
    code = codeOf(link);
    if (code !== undefined) {
      break;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : "unknown",
    code,
    message:
      message.length > MAX_LOGGED_MESSAGE_LENGTH ? `${message.slice(0, MAX_LOGGED_MESSAGE_LENGTH - 1)}…` : message
  };
}
