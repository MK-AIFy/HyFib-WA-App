import { EventTopics, incCounter, verifyMetaSignature } from "@hyfib/shared-core";
import type { Logger } from "@hyfib/shared-core";
import type { EventBus } from "@hyfib/event-bus";
import {
  normalizeInbound,
  normalizeStatus,
  type RawValue,
  normalizeSocialInbound,
  type RawMessagingEvent
} from "./normalize.js";

export interface WebhookPayload {
  /** "whatsapp_business_account" | "page" (Messenger) | "instagram" */
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: RawValue;
    }>;
    messaging?: RawMessagingEvent[];
  }>;
}

export interface IdempotencyStore {
  isDuplicate(key: string): Promise<boolean>;
  /**
   * Release a previously claimed key. Optional so third-party/legacy
   * implementers of this interface without a release method remain
   * compatible; when absent, a failed publish simply cannot release its
   * claim (falls back to prior at-most-once-per-TTL behavior).
   */
  release?(key: string): Promise<void>;
}

export interface IngestDeps {
  eventBus: EventBus;
  idempotency: IdempotencyStore;
  /**
   * Optional diagnostics logger. Never affects control flow — e.g. when a
   * release() call (see below) itself fails, it's logged here rather than
   * replacing the original error. Optional/silent-by-default so existing
   * callers and tests that don't supply one remain compatible.
   */
  logger?: Logger;
}

export interface IngestSummary {
  inbound: number;
  statuses: number;
  duplicates: number;
}

export function safeJsonParse(value: string): WebhookPayload {
  try {
    return JSON.parse(value) as WebhookPayload;
  } catch {
    return {};
  }
}

export function deriveTenantId(payload: WebhookPayload, fallbackTenantId?: string): string | undefined {
  return payload.entry?.[0]?.id ?? fallbackTenantId;
}

/**
 * Normalize + publish inbound messages and status updates from a Meta webhook
 * payload onto the injected event bus, deduplicating via the injected
 * idempotency store. Pure of transport concerns so both the standalone
 * webhook-ingestor service and the app-server monolith reuse it.
 */
export async function ingestMetaWebhook(
  payload: WebhookPayload,
  tenantId: string | undefined,
  deps: IngestDeps
): Promise<IngestSummary> {
  let inbound = 0;
  let statuses = 0;
  let duplicates = 0;

  for (const entry of payload.entry ?? []) {
    // Messenger/Instagram webhooks (Phase F): entry[].messaging[] instead of
    // changes[]. Echoes (our own sends reflected back) are skipped; dedupe by
    // message mid with the same claim/release discipline as WhatsApp.
    if ((payload.object === "page" || payload.object === "instagram") && entry.messaging) {
      for (const event of entry.messaging) {
        if (!event.message?.mid || event.message.is_echo) {
          continue;
        }
        const key = `social:${event.message.mid}`;
        if (await deps.idempotency.isDuplicate(key)) {
          duplicates += 1;
          continue;
        }
        inbound += 1;
        incCounter("events_published_total", "Events published to the bus.", {
          topic: EventTopics.SocialInboundReceived
        });
        try {
          await deps.eventBus.publish(
            EventTopics.SocialInboundReceived,
            { ...normalizeSocialInbound(payload.object, event, entry.id) },
            tenantId
          );
        } catch (error) {
          try {
            await deps.idempotency.release?.(key);
          } catch (releaseError) {
            deps.logger?.warn("idempotency_release_failed", {
              key,
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            });
          }
          throw error;
        }
      }
      continue;
    }
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) {
        continue;
      }

      for (const message of value.messages ?? []) {
        const key = `inbound:${message.id ?? "unknown"}`;
        if (await deps.idempotency.isDuplicate(key)) {
          duplicates += 1;
          continue;
        }

        inbound += 1;
        incCounter("events_published_total", "Events published to the bus.", {
          topic: EventTopics.WhatsAppInboundReceived
        });
        try {
          await deps.eventBus.publish(
            EventTopics.WhatsAppInboundReceived,
            { ...normalizeInbound(value, message, entry.id) },
            tenantId
          );
        } catch (error) {
          // Publish failed after the idempotency key was claimed — release it
          // so a retry of the same webhook (e.g. Meta re-delivery) isn't
          // swallowed as a duplicate. Guard the release itself: if it throws
          // (e.g. Redis is also down), log that separately and still rethrow
          // the ORIGINAL publish error rather than masking it.
          try {
            await deps.idempotency.release?.(key);
          } catch (releaseError) {
            deps.logger?.warn("idempotency_release_failed", {
              key,
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            });
          }
          throw error;
        }
      }

      for (const status of value.statuses ?? []) {
        const key = `status:${status.id ?? "unknown"}:${status.status ?? "unknown"}`;
        if (await deps.idempotency.isDuplicate(key)) {
          duplicates += 1;
          continue;
        }

        statuses += 1;
        incCounter("events_published_total", "Events published to the bus.", {
          topic: EventTopics.WhatsAppStatusUpdated
        });
        try {
          await deps.eventBus.publish(
            EventTopics.WhatsAppStatusUpdated,
            { ...normalizeStatus(value, status, entry.id) },
            tenantId
          );
        } catch (error) {
          // Publish failed after the idempotency key was claimed — release it
          // so a retry of the same webhook (e.g. Meta re-delivery) isn't
          // swallowed as a duplicate. Guard the release itself: if it throws
          // (e.g. Redis is also down), log that separately and still rethrow
          // the ORIGINAL publish error rather than masking it.
          try {
            await deps.idempotency.release?.(key);
          } catch (releaseError) {
            deps.logger?.warn("idempotency_release_failed", {
              key,
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            });
          }
          throw error;
        }
      }
    }
  }

  return { inbound, statuses, duplicates };
}

export interface ForwardedWebhook {
  rawBody: string;
  signature?: string;
  tenantId?: string;
}

export interface ProcessWebhookDeps extends IngestDeps {
  metaAppSecret: string;
}

export interface ProcessWebhookResult {
  verified: boolean;
  summary: IngestSummary;
}

/**
 * Verify a forwarded raw webhook body against the Meta app secret, then ingest
 * it. Mirrors the standalone service's `/internal/v1/webhooks/meta/whatsapp`
 * endpoint so the gateway can call it directly in-process (monolith) instead
 * of over HTTP.
 */
export async function processForwardedWebhook(
  forwarded: ForwardedWebhook,
  deps: ProcessWebhookDeps
): Promise<ProcessWebhookResult> {
  if (!verifyMetaSignature(forwarded.rawBody, forwarded.signature, deps.metaAppSecret)) {
    return { verified: false, summary: { inbound: 0, statuses: 0, duplicates: 0 } };
  }
  const payload = safeJsonParse(forwarded.rawBody);
  const scopedTenant = deriveTenantId(payload, forwarded.tenantId);
  const summary = await ingestMetaWebhook(payload, scopedTenant, deps);
  return { verified: true, summary };
}
