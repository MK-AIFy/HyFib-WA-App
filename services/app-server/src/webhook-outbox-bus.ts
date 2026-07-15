import { randomUUID } from "node:crypto";
import type { EventBus } from "@hyfib/event-bus";
import type { EventEnvelope, EventTopic, Logger } from "@hyfib/shared-core";

export interface DurableWebhookBusDeps {
  /** Resolves a Meta `phone_number_id` to the owning tenant's UUID, or undefined if unroutable. */
  resolveTenant: (phoneNumberId: string) => Promise<string | undefined>;
  /** Inserts a durable outbox row (same rails as Tasks 7-8: attempts/backoff/dead-letter, replayed by the 1s relay). */
  enqueue: (tenantId: string, topic: EventTopic, payload: unknown) => Promise<void>;
  logger: Logger;
}

function extractPhoneNumberId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const phoneNumberId = (payload as { phoneNumberId?: unknown }).phoneNumberId;
  return typeof phoneNumberId === "string" && phoneNumberId.length > 0 ? phoneNumberId : undefined;
}

/**
 * Decorates an EventBus so inbound webhook publishes route through the durable
 * DB outbox instead of landing directly on the shared bus. Normalized
 * inbound/status payloads (see webhook-ingestor/src/normalize.ts) carry
 * `phoneNumberId`; when it resolves to a tenant we enqueue an outbox row
 * (crash-safe, retried with backoff, dead-letterable via the gateway's 1s
 * relay) instead of publishing directly — the relay republishes it onto the
 * real bus with the outbox row's tenant UUID. Unroutable events (missing or
 * unresolvable phoneNumberId) fall back to publishing straight on `inner`,
 * matching today's best-effort behavior since they can't be tenant-scoped
 * anyway.
 *
 * Composition-only decorator: webhook-ingestor keeps its plain injected
 * EventBus untouched; only app-server's composition root (main.ts) wires this
 * in, and only for `processForwardedWebhook`'s deps. Worker registration and
 * gateway/SSE fan-out keep using the raw shared bus.
 */
export function createDurableWebhookBus(inner: EventBus, deps: DurableWebhookBusDeps): EventBus {
  return {
    async publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>> {
      const phoneNumberId = extractPhoneNumberId(payload);
      const resolvedTenantId = phoneNumberId ? await deps.resolveTenant(phoneNumberId) : undefined;

      if (resolvedTenantId) {
        // Not swallowed: if the insert fails, this rejects so the webhook
        // handler sees the failure and can respond with a 502 to Meta (which
        // retries), rather than silently dropping the event.
        await deps.enqueue(resolvedTenantId, topic, payload);
        return {
          id: randomUUID(),
          topic,
          tenantId: resolvedTenantId,
          payload,
          occurredAt: new Date().toISOString()
        };
      }

      deps.logger.warn("webhook_event_direct_publish", { topic, phoneNumberId, tenantId });
      return inner.publish(topic, payload, tenantId);
    },
    subscribe(topic, queue, handler, options) {
      inner.subscribe(topic, queue, handler, options);
    },
    close(): Promise<void> {
      return inner.close();
    }
  };
}
