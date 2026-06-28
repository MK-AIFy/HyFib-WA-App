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

  private pruneExpired(now: number): void {
    this.lastPruneAt = now;
    for (const [key, expiry] of this.store.entries()) {
      if (expiry < now) {
        this.store.delete(key);
      }
    }
  }
}
