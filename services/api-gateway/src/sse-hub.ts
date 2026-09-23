import { randomUUID } from "node:crypto";

/** Minimal sink interface so the hub can be unit-tested without sockets. */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
}

export function formatSseFrame(eventName: string, id: string, data: unknown): string {
  return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * How long one stream may stay open. A stream is authorised once, at connect, so this bounds how long a revocation
 * the hub was not told about (one made on another gateway instance, or by a path that does not end streams) can
 * leave it delivering. The web-app reconnects on its own, and a reconnect is authorised afresh.
 */
export const DEFAULT_SSE_MAX_STREAM_AGE_MS = 10 * 60_000;

/** Who a stream was opened for, so that revoking that credential can end the stream too. */
export interface SseClientOwner {
  /** The authenticated subject (a users.id for a signed-in user). Matched without regard to letter case. */
  userId?: string;
  /** Identifies the session the stream authenticated with (the gateway passes its token hash), if it was one. */
  sessionKey?: string;
}

export interface SseHubOptions {
  /** Lifetime cap for a stream; defaults to DEFAULT_SSE_MAX_STREAM_AGE_MS. Enforced by the keep-alive sweep. */
  maxStreamAgeMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /**
   * Called with the number of streams the keep-alive sweep ended at the lifetime cap (only when it is non-zero).
   * The cap is the backstop for revocations on other instances, so the host logs these like any other closure.
   */
  onExpired?: (count: number) => void;
}

interface SseClient {
  id: string;
  sink: SseSink;
  userId?: string;
  sessionKey?: string;
  openedAt: number;
}

function endQuietly(sink: SseSink): void {
  try {
    sink.end();
  } catch {
    // Already gone.
  }
}

/**
 * Tracks connected Server-Sent-Events clients per tenant and fans events out
 * to them. Delivery is best-effort: a failed write just drops that client.
 * Each stream records who opened it, so a revoked user or session can have its
 * streams ended, and no stream outlives the lifetime cap.
 */
export class SseHub {
  private readonly clients = new Map<string, SseClient[]>();
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private readonly maxStreamAgeMs: number;
  private readonly now: () => number;
  private readonly onExpired: ((count: number) => void) | undefined;

  constructor(options: SseHubOptions = {}) {
    this.maxStreamAgeMs = options.maxStreamAgeMs ?? DEFAULT_SSE_MAX_STREAM_AGE_MS;
    this.now = options.now ?? Date.now;
    this.onExpired = options.onExpired;
  }

  addClient(tenantId: string, sink: SseSink, owner: SseClientOwner = {}): string {
    const id = randomUUID();
    const current = this.clients.get(tenantId) ?? [];
    current.push({
      id,
      sink,
      userId: owner.userId?.toLowerCase(),
      sessionKey: owner.sessionKey,
      openedAt: this.now()
    });
    this.clients.set(tenantId, current);
    return id;
  }

  /** Ends every stream opened by `userId`, in any tenant; returns how many. */
  closeUserStreams(userId: string): number {
    const wanted = userId.toLowerCase();
    return this.closeWhere((client) => client.userId === wanted);
  }

  /** Ends every stream opened with the session `sessionKey` identifies; returns how many. */
  closeSessionStreams(sessionKey: string): number {
    return this.closeWhere((client) => client.sessionKey === sessionKey);
  }

  /** Ends every stream that has reached the lifetime cap; returns how many. */
  closeExpired(): number {
    const cutoff = this.now() - this.maxStreamAgeMs;
    return this.closeWhere((client) => client.openedAt <= cutoff);
  }

  private closeWhere(matches: (client: SseClient) => boolean): number {
    let closed = 0;
    for (const [tenantId, current] of [...this.clients]) {
      for (const client of current.filter(matches)) {
        endQuietly(client.sink);
        this.removeClient(tenantId, client.id);
        closed += 1;
      }
    }
    return closed;
  }

  removeClient(tenantId: string, clientId: string): void {
    const current = this.clients.get(tenantId);
    if (!current) {
      return;
    }
    const remaining = current.filter((client) => client.id !== clientId);
    if (remaining.length === 0) {
      this.clients.delete(tenantId);
    } else {
      this.clients.set(tenantId, remaining);
    }
  }

  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /** Sends an event to every client of the tenant; returns how many received it. */
  broadcast(tenantId: string, eventName: string, id: string, payload: unknown): number {
    const current = this.clients.get(tenantId);
    if (!current || current.length === 0) {
      return 0;
    }
    const frame = formatSseFrame(eventName, id, payload);
    let delivered = 0;
    for (const client of [...current]) {
      try {
        client.sink.write(frame);
        delivered += 1;
      } catch {
        this.removeClient(tenantId, client.id);
      }
    }
    return delivered;
  }

  /**
   * Comment-frame heartbeat so proxies and clients keep the connection open. Streams past the lifetime cap are
   * ended instead, so the cap holds to within one keep-alive interval.
   */
  pingAll(): void {
    const expired = this.closeExpired();
    if (expired > 0) {
      this.onExpired?.(expired);
    }
    for (const [tenantId, current] of this.clients) {
      for (const client of [...current]) {
        try {
          client.sink.write(": ping\n\n");
        } catch {
          this.removeClient(tenantId, client.id);
        }
      }
    }
  }

  startKeepAlive(intervalMs = 25_000): void {
    if (this.keepAliveTimer) {
      return;
    }
    this.keepAliveTimer = setInterval(() => this.pingAll(), intervalMs);
    this.keepAliveTimer.unref();
  }

  close(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    for (const current of this.clients.values()) {
      for (const client of current) {
        endQuietly(client.sink);
      }
    }
    this.clients.clear();
  }
}
