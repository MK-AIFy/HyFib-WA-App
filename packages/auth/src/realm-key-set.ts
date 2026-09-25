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
import { errorCode, isTokenVerdict } from "./token-verdict.js";

/**
 * The realm's signing keys, fetched from its JWKS URI and ridden through an outage of that endpoint.
 *
 * jose's remote key set caches what it fetches (for 10 minutes by default), but once that has expired a refresh that
 * fails fails the token: ten minutes into a Keycloak outage every token was answered 503, though the keys that signed
 * it had not changed. Here a refresh that fails falls back on the keys of the last successful fetch, for less than
 * `maxStaleMs` after it. Meanwhile no token waits on the realm: it is tried again in the background once per
 * `retryIntervalMs`, and the first try that succeeds ends the outage.
 *
 * The fallback never outvotes the realm. It is used only when the realm could not be asked; a realm that answers is
 * believed, so a key it has withdrawn is refused as soon as it is reachable. A token naming a key id the last good set
 * does not hold is neither accepted nor refused (the realm may have published that key since): the outage is the
 * answer. jwtVerify still checks signature, issuer, audience and expiry against whichever key this returns.
 */
export interface RealmKeySetOptions {
  /**
   * How long after the last successful fetch its keys may still verify tokens while the realm cannot be reached.
   * 0 turns the fallback off.
   */
  maxStaleMs?: number;
  /** While the realm cannot be reached, how often to try it again, in the background. */
  retryIntervalMs?: number;
  /** jose's own settings for fetching and caching the key set. */
  remote?: Pick<RemoteJWKSetOptions, "cacheMaxAge" | "cooldownDuration" | "timeoutDuration">;
  /** The clock the two limits above are measured on (for tests). */
  now?: () => number;
  /** Where an outage's start, the fallback running out, and the outage's end are logged. */
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

/** 24 hours: through a long outage, without trusting keys the realm may since have withdrawn indefinitely. */
export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETRY_INTERVAL_MS = 30 * 1000;

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
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger("auth");
  // Never the query string or credentials, should the URI carry any.
  const endpoint = `${jwksUri.origin}${jwksUri.pathname}`;
  // jose records each successful fetch here: the key set and when it arrived (uat). A fetch that fails leaves it be.
  const lastFetch: JWKSCacheInput = {};
  const remote = createRemoteJWKSet(jwksUri, { ...options.remote, [jwksCache]: lastFetch });
  let outage: Outage | undefined;
  let retrying = false;
  let lastGood: { source: JSONWebKeySet; keys: JWTVerifyGetKey } | undefined;

  /** The keys of the last successful fetch, while recent enough to use. */
  function lastGoodKeys(): JWTVerifyGetKey | undefined {
    if (!("jwks" in lastFetch) || now() - lastFetch.uat >= maxStaleMs) {
      return undefined;
    }
    if (lastGood?.source !== lastFetch.jwks) {
      lastGood = { source: lastFetch.jwks, keys: createLocalJWKSet(lastFetch.jwks) };
    }
    return lastGood.keys;
  }

  function lastFetchedAt(): string | null {
    return "uat" in lastFetch ? new Date(lastFetch.uat).toISOString() : null;
  }

  function endOutage(): void {
    if (outage === undefined) {
      return;
    }
    logger.info("keycloak_jwks_recovered", { jwksUri: endpoint, outageMs: now() - outage.since });
    outage = undefined;
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
      .then(endOutage, (error: unknown) => {
        current.error = error;
      })
      .finally(() => {
        retrying = false;
      });
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
    try {
      const key = await remote(header, token);
      endOutage();
      return key;
    } catch (error) {
      if (isTokenVerdict(error)) {
        throw error;
      }
      const keys = lastGoodKeys();
      if (outage === undefined) {
        outage = { since: now(), lastAttemptAt: now(), error, onLastGoodKeys: keys !== undefined };
        logger.warn("keycloak_jwks_unavailable", {
          ...describe(error),
          jwksUri: endpoint,
          lastFetchedAt: lastFetchedAt(),
          fallback: keys === undefined ? "none" : "last_good_keys"
        });
      } else {
        outage.lastAttemptAt = now();
        outage.error = error;
      }
      if (keys === undefined) {
        throw error;
      }
      return fromLastGoodKeys(keys, error, header, token);
    }
  };
}
