import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwksCache,
  type JSONWebKeySet,
  type JWKSCacheInput,
  type JWTVerifyGetKey,
  type RemoteJWKSetOptions
} from "jose";
import { Logger } from "@hyfib/shared-core";
import { errorCode } from "./token-verdict.js";

/**
 * The realm's signing keys, fetched from its JWKS URI and ridden through an outage of that endpoint.
 *
 * jose's remote key set caches what it fetches (for 10 minutes by default), but once that has expired a refresh that
 * fails fails the token: ten minutes into a Keycloak outage every token was answered 503, though the keys that signed
 * it had not changed. Here a fetch that fails falls back on the keys of the last successful fetch, for less than
 * `maxStaleMs` after it. Meanwhile no token waits on the realm: it is tried again in the background once per
 * `retryIntervalMs`, and the first try that succeeds ends the outage.
 *
 * Only a fetch that fails is an outage. jose fetches the key set (with its timeout, one fetch at a time, and a check
 * that what came back is a key set), but keys are resolved from the fetched set here, so a problem with one key of a
 * set the realm did serve (a key id the set does not hold, or a key jose cannot use) is that token's answer alone: it
 * never starts an outage, and never moves other tokens onto the fallback. For the same reason the cache and cooldown
 * rules jose would apply are applied here, with its defaults: the set is fetched again once it is `cacheMaxAge` old,
 * and for a key id it does not hold, at most once per `cooldownDuration`.
 *
 * The fallback never outvotes the realm. It is used only when the realm could not be asked; a realm that answers is
 * believed, so a key it has withdrawn is refused as soon as it is reachable. A token naming a key id the last good set
 * does not hold is neither accepted nor refused (the realm may have published that key since): the outage is the
 * answer. jwtVerify still checks signature, issuer, audience and expiry against whichever key this returns.
 */
export interface RealmKeySetOptions {
  /**
   * How long after the last successful fetch its keys may still verify tokens while the realm cannot be reached. It
   * counts from that fetch, as `remote.cacheMaxAge` does, so it extends nothing unless it is longer than that (10
   * minutes by default): until then the cached keys are used without asking the realm. 0 turns the fallback off.
   */
  maxStaleMs?: number;
  /** While the realm cannot be reached, how often to try it again, in the background. */
  retryIntervalMs?: number;
  /** jose's settings for fetching and caching the key set, with jose's meaning and defaults. */
  remote?: Pick<RemoteJWKSetOptions, "cacheMaxAge" | "cooldownDuration" | "timeoutDuration">;
  /** The clock the limits above are measured on (for tests). */
  now?: () => number;
  /** Where an outage's start, the fallback running out, and the outage's end are logged. */
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

/** 24 hours: through a long outage, without trusting keys the realm may since have withdrawn indefinitely. */
export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETRY_INTERVAL_MS = 30 * 1000;
/** jose's own defaults for `cacheMaxAge` and `cooldownDuration`. */
const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;

interface Outage {
  since: number;
  lastAttemptAt: number;
  /** Why the realm could not be asked, most recently: the answer for a token the last good keys cannot settle. */
  error: unknown;
  /** Whether tokens are being verified on the last good keys, so that their running out is logged once. */
  onLastGoodKeys: boolean;
}

type GetKeyArguments = Parameters<JWTVerifyGetKey>;

function describe(error: unknown): { errorName: string; errorCode: string | undefined; error: string } {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: errorCode(error),
    error: error instanceof Error ? error.message : String(error)
  };
}

export function createRealmKeySet(jwksUri: URL, options: RealmKeySetOptions = {}): JWTVerifyGetKey {
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const cacheMaxAgeMs = options.remote?.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE_MS;
  const cooldownMs = options.remote?.cooldownDuration ?? DEFAULT_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger("auth");
  // Never the query string or credentials, should the URI carry any.
  const endpoint = `${jwksUri.origin}${jwksUri.pathname}`;
  // jose records the key set of each successful fetch here; a fetch that fails leaves it be. When it arrived is kept in
  // fetchedAt, on this module's clock, since every fetch is made here.
  const lastFetch: JWKSCacheInput = {};
  const remote = createRemoteJWKSet(jwksUri, {
    timeoutDuration: options.remote?.timeoutDuration,
    [jwksCache]: lastFetch
  });
  let fetchedAt: number | undefined;
  let outage: Outage | undefined;
  let retrying = false;
  let fetched: { source: JSONWebKeySet; keys: JWTVerifyGetKey } | undefined;

  /** How long ago the last successful fetch was; Infinity before the first. */
  function fetchAgeMs(): number {
    return fetchedAt === undefined ? Infinity : now() - fetchedAt;
  }

  /** The keys of the last successful fetch, whatever their age; undefined before the first. */
  function fetchedKeys(): JWTVerifyGetKey | undefined {
    if (!("jwks" in lastFetch)) {
      return undefined;
    }
    if (fetched?.source !== lastFetch.jwks) {
      fetched = { source: lastFetch.jwks, keys: createLocalJWKSet(lastFetch.jwks) };
    }
    return fetched.keys;
  }

  /** The keys of the last successful fetch, while recent enough to fall back on. */
  function lastGoodKeys(): JWTVerifyGetKey | undefined {
    return fetchAgeMs() < maxStaleMs ? fetchedKeys() : undefined;
  }

  function lastFetchedAt(): string | null {
    return fetchedAt === undefined ? null : new Date(fetchedAt).toISOString();
  }

  /** The realm answered with a key set: that ends any outage, whatever any token's answer turns out to be. */
  function fetchSucceeded(): void {
    fetchedAt = now();
    if (outage === undefined) {
      return;
    }
    logger.info("keycloak_jwks_recovered", { jwksUri: endpoint, outageMs: now() - outage.since });
    outage = undefined;
  }

  /** Asks the realm for its key set: its keys, or why they could not be had. */
  async function fetchKeys(): Promise<{ keys: JWTVerifyGetKey } | { failure: unknown }> {
    try {
      await remote.reload();
    } catch (error) {
      return { failure: error };
    }
    fetchSucceeded();
    const keys = fetchedKeys();
    if (keys === undefined) {
      // jose records a successful fetch before reload() resolves.
      throw new Error("jose reported a successful JWKS fetch without recording it");
    }
    return { keys };
  }

  /** Tries the realm again, in the background, at most once per retry interval. */
  function retryInBackground(current: Outage): void {
    if (retrying || now() - current.lastAttemptAt < retryIntervalMs) {
      return;
    }
    retrying = true;
    current.lastAttemptAt = now();
    void remote
      .reload()
      .then(fetchSucceeded, (error: unknown) => {
        current.error = error;
      })
      .finally(() => {
        retrying = false;
      })
      .catch(() => undefined);
  }

  /** A key from the last good set; for a key id it does not hold, the outage is the answer, not a refusal. */
  async function fromLastGoodKeys(keys: JWTVerifyGetKey, outageError: unknown, ...[header, token]: GetKeyArguments) {
    try {
      return await keys(header, token);
    } catch (error) {
      if (errorCode(error) === "ERR_JWKS_NO_MATCHING_KEY") {
        throw outageError;
      }
      throw error;
    }
  }

  /** The realm could not be asked: the outage starts or goes on, and the last good keys answer if there are any. */
  async function duringOutage(failure: unknown, ...[header, token]: GetKeyArguments) {
    const keys = lastGoodKeys();
    if (outage === undefined) {
      outage = { since: now(), lastAttemptAt: now(), error: failure, onLastGoodKeys: keys !== undefined };
      logger.warn("keycloak_jwks_unavailable", {
        ...describe(failure),
        jwksUri: endpoint,
        lastFetchedAt: lastFetchedAt(),
        fallback: keys === undefined ? "none" : "last_good_keys"
      });
    } else {
      outage.lastAttemptAt = now();
      outage.error = failure;
    }
    if (keys === undefined) {
      throw failure;
    }
    return fromLastGoodKeys(keys, failure, header, token);
  }

  return async (header, token) => {
    if (outage !== undefined) {
      const keys = lastGoodKeys();
      if (keys !== undefined) {
        retryInBackground(outage);
        return fromLastGoodKeys(keys, outage.error, header, token);
      }
      if (outage.onLastGoodKeys) {
        outage.onLastGoodKeys = false;
        logger.error("keycloak_jwks_last_good_keys_expired", {
          jwksUri: endpoint,
          lastFetchedAt: lastFetchedAt(),
          maxStaleMs
        });
      }
      // Nothing left to fall back on: ask the realm, as jose would.
    }
    let keys = fetchAgeMs() < cacheMaxAgeMs ? fetchedKeys() : undefined;
    if (keys === undefined) {
      const attempt = await fetchKeys();
      if ("failure" in attempt) {
        return duringOutage(attempt.failure, header, token);
      }
      keys = attempt.keys;
    }
    try {
      return await keys(header, token);
    } catch (error) {
      // Any other error is this token's answer alone: a verdict, or a key of the set jose cannot use.
      if (errorCode(error) !== "ERR_JWKS_NO_MATCHING_KEY" || fetchAgeMs() < cooldownMs) {
        throw error;
      }
      // A key id the set does not hold: the realm may have published it since. Ask again, once per cooldown.
      const attempt = await fetchKeys();
      if ("failure" in attempt) {
        return duringOutage(attempt.failure, header, token);
      }
      return attempt.keys(header, token);
    }
  };
}
