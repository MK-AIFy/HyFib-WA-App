import { Redis } from "ioredis";
import type { PlatformConfig } from "@hyfib/config";

let redisClient: Redis | undefined;

export function getRedisClient(config: PlatformConfig): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3
    });
    redisClient.on("error", () => {
      // Swallow — Redis is non-critical; we degrade gracefully if unavailable.
    });
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => undefined);
    redisClient = undefined;
  }
}

/**
 * Token-bucket rate limiter backed by Redis.
 * Falls back to allowed:true when Redis is unavailable (non-critical path).
 * Key format: rl:{scope}:{windowStart} — counts within 1-minute windows.
 */
export async function checkRateLimit(
  redis: Redis,
  scope: string,
  ratePerMinute: number
): Promise<{ allowed: boolean; waitMs: number }> {
  try {
    const now = Date.now();
    const windowMs = 60_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `rl:${scope}:${windowStart}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, windowMs * 2);
    }
    if (count <= ratePerMinute) {
      return { allowed: true, waitMs: 0 };
    }
    const msUntilNextWindow = windowStart + windowMs - now;
    return { allowed: false, waitMs: msUntilNextWindow };
  } catch {
    return { allowed: true, waitMs: 0 };
  }
}

/**
 * Acquires a rate-limit slot, sleeping if needed.
 * Never throws; degrades gracefully if Redis is unreachable.
 */
export async function acquireRateLimit(redis: Redis, scope: string, ratePerMinute: number): Promise<void> {
  const maxWaitMs = 70_000;
  let waited = 0;
  while (waited < maxWaitMs) {
    const { allowed, waitMs } = await checkRateLimit(redis, scope, ratePerMinute);
    if (allowed) return;
    const sleep = Math.min(waitMs, 5_000);
    await new Promise<void>((r) => setTimeout(r, sleep));
    waited += sleep;
  }
}
