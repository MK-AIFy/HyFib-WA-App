import { randomUUID } from "node:crypto";

/** Minimal sink interface so the hub can be unit-tested without sockets. */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
}

export function formatSseFrame(eventName: string, id: string, data: unknown): string {
  return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface SseClient {
  id: string;
  sink: SseSink;
}

/**
 * Tracks connected Server-Sent-Events clients per tenant and fans events out
 * to them. Delivery is best-effort: a failed write just drops that client.
 */
export class SseHub {
  private readonly clients = new Map<string, SseClient[]>();
  private keepAliveTimer: NodeJS.Timeout | undefined;

  addClient(tenantId: string, sink: SseSink): string {
    const id = randomUUID();
    const current = this.clients.get(tenantId) ?? [];
    current.push({ id, sink });
    this.clients.set(tenantId, current);
    return id;
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

  /** Comment-frame heartbeat so proxies and clients keep the connection open. */
  pingAll(): void {
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
        try {
          client.sink.end();
        } catch {
          // Already gone.
        }
      }
    }
    this.clients.clear();
  }
}
