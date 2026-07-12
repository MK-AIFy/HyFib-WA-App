export class IdempotencyStore {
  private readonly store = new Map<string, number>();
  private lastPruneAt = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly pruneIntervalMs = 60_000
  ) {}

  isDuplicate(key: string): boolean {
    const now = Date.now();
    if (now - this.lastPruneAt >= this.pruneIntervalMs) {
      this.pruneExpired(now);
    }
    const existing = this.store.get(key);
    if (existing === undefined || existing < now) {
      this.store.set(key, now + this.ttlMs);
      return false;
    }
    return true;
  }

  /**
   * Release a previously claimed key so a subsequent isDuplicate() call for
   * the same key is treated as a fresh claim. Used when the caller claimed
   * the key but then failed to process/publish the associated work, so a
   * retry (e.g. Meta re-delivering a webhook) isn't swallowed as a duplicate.
   */
  async release(key: string): Promise<void> {
    this.store.delete(key);
  }

  private pruneExpired(now: number): void {
    this.lastPruneAt = now;
    for (const [key, expiry] of this.store.entries()) {
      if (expiry < now) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Minimal Redis interface required by RedisIdempotencyStore.
 * Typed as a structural subset so that ioredis.Redis satisfies it
 * without importing ioredis into shared-core.
 */
export interface RedisSetNx {
  set(
    key: string,
    value: string,
    expiryMode: string,
    time: number,
    setMode: string
  ): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * Redis-backed idempotency store.
 * Uses SET … EX … NX so that the first caller wins and subsequent callers
 * with the same key within the TTL window are treated as duplicates.
 * Safe for use across multiple service instances.
 */
export class RedisIdempotencyStore {
  constructor(
    private readonly redis: RedisSetNx,
    private readonly ttlSeconds: number,
    private readonly keyPrefix = "idm:"
  ) {}

  async isDuplicate(key: string): Promise<boolean> {
    // Returns "OK" when the key was newly set (first time = not a duplicate).
    // Returns null when the key already existed (duplicate).
    const result = await this.redis.set(
      `${this.keyPrefix}${key}`,
      "1",
      "EX",
      this.ttlSeconds,
      "NX"
    );
    return result === null;
  }

  /**
   * Release a previously claimed key so a subsequent isDuplicate() call for
   * the same key is treated as a fresh claim. Used when the caller claimed
   * the key but then failed to process/publish the associated work, so a
   * retry (e.g. Meta re-delivering a webhook) isn't swallowed as a duplicate.
   */
  async release(key: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}${key}`);
  }
}
