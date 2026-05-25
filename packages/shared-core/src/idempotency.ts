export class IdempotencyStore {
  private readonly store = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  isDuplicate(key: string): boolean {
    this.pruneExpired();
    const existing = this.store.get(key);
    if (existing === undefined) {
      this.store.set(key, Date.now() + this.ttlMs);
      return false;
    }
    return true;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, expiry] of this.store.entries()) {
      if (expiry < now) {
        this.store.delete(key);
      }
    }
  }
}
