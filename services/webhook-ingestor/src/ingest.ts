import { EventTopics, incCounter, verifyMetaSignature } from "@hyfib/shared-core";
import type { EventBus } from "@hyfib/event-bus";
import { normalizeInbound, normalizeStatus, type RawValue } from "./normalize.js";

export interface WebhookPayload {
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: RawValue;
    }>;
  }>;
}

export interface IdempotencyStore {
  isDuplicate(key: string): Promise<boolean>;
}

export interface IngestDeps {
  eventBus: EventBus;
  idempotency: IdempotencyStore;
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
        await deps.eventBus.publish(
          EventTopics.WhatsAppInboundReceived,
          { ...normalizeInbound(value, message, entry.id) },
          tenantId
        );
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
        await deps.eventBus.publish(
          EventTopics.WhatsAppStatusUpdated,
          { ...normalizeStatus(value, status, entry.id) },
          tenantId
        );
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
