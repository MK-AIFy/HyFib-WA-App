import { createServer } from "node:http";
import { RabbitMqEventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import {
  EventTopics,
  IdempotencyStore,
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readRawBody,
  requestContext,
  sendJson,
  verifyMetaSignature
} from "@hyfib/shared-core";

interface WebhookPayload {
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          phone_number_id?: string;
        };
        contacts?: Array<{ wa_id?: string }>;
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
          timestamp?: string;
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          recipient_id?: string;
          timestamp?: string;
          errors?: Array<{ code?: number; title?: string }>;
        }>;
      };
    }>;
  }>;
}

interface ForwardedWebhookRequest {
  rawBody: string;
  signature?: string;
  tenantId?: string;
}

const config = loadConfig();
const logger = new Logger("webhook-ingestor", config.logLevel as "debug" | "info" | "warn" | "error");
const eventBus = new RabbitMqEventBus();
const idempotency = new IdempotencyStore(24 * 60 * 60 * 1000);

function safeJsonParse(value: string): WebhookPayload {
  try {
    return JSON.parse(value) as WebhookPayload;
  } catch {
    return {};
  }
}

function deriveTenantId(payload: WebhookPayload, fallbackTenantId?: string): string | undefined {
  return payload.entry?.[0]?.id ?? fallbackTenantId;
}

async function ingest(payload: WebhookPayload, tenantId?: string): Promise<{ inbound: number; statuses: number; duplicates: number }> {
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
        if (idempotency.isDuplicate(key)) {
          duplicates += 1;
          continue;
        }

        inbound += 1;
        await eventBus.publish(
          EventTopics.WhatsAppInboundReceived,
          {
            entryId: entry.id,
            phoneNumberId: value.metadata?.phone_number_id,
            messageId: message.id,
            from: message.from,
            text: message.text?.body,
            timestamp: message.timestamp,
            type: message.type
          },
          tenantId
        );
      }

      for (const status of value.statuses ?? []) {
        const key = `status:${status.id ?? "unknown"}:${status.status ?? "unknown"}`;
        if (idempotency.isDuplicate(key)) {
          duplicates += 1;
          continue;
        }

        statuses += 1;
        await eventBus.publish(
          EventTopics.WhatsAppStatusUpdated,
          {
            entryId: entry.id,
            phoneNumberId: value.metadata?.phone_number_id,
            messageId: status.id,
            status: status.status,
            recipientId: status.recipient_id,
            timestamp: status.timestamp,
            errors: status.errors ?? []
          },
          tenantId
        );
      }
    }
  }

  return { inbound, statuses, duplicates };
}

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "webhook-ingestor",
      status: "ok",
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/internal/v1/webhooks/meta/whatsapp") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const raw = await readRawBody(req);
    let rawBody = raw;
    let signature = req.headers["x-hub-signature-256"];
    let tenantId: string | undefined = ctx.tenantId;

    if (req.headers["content-type"]?.includes("application/json")) {
      const forwarded = safeJsonParse(raw) as ForwardedWebhookRequest;
      if (typeof forwarded.rawBody === "string") {
        rawBody = forwarded.rawBody;
        signature = forwarded.signature;
        tenantId = forwarded.tenantId ?? tenantId;
      }
    }

    const normalizedSignature = typeof signature === "string" ? signature : undefined;

    if (!verifyMetaSignature(rawBody, normalizedSignature, config.metaAppSecret)) {
      logger.warn("webhook_signature_invalid", { requestId: ctx.requestId });
      sendJson(res, 401, { error: "Invalid webhook signature" });
      return;
    }

    const payload = safeJsonParse(rawBody);
    const scopedTenant = deriveTenantId(payload, tenantId);
    const summary = await ingest(payload, scopedTenant);

    logger.info("webhook_ingested", {
      requestId: ctx.requestId,
      tenantId: scopedTenant,
      inbound: summary.inbound,
      statuses: summary.statuses,
      duplicates: summary.duplicates
    });

    sendJson(res, 200, {
      status: "accepted",
      requestId: ctx.requestId,
      tenantId: scopedTenant,
      ...summary
    });
    return;
  }

  if (path === "/internal/v1/webhooks/meta/whatsapp/replay") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const raw = await readRawBody(req);
    const payload = safeJsonParse(raw);
    const summary = await ingest(payload, ctx.tenantId);

    sendJson(res, 200, {
      status: "replayed",
      requestId: ctx.requestId,
      ...summary
    });
    return;
  }

  notFound(res);
});

server.listen(config.webhookIngestorPort, () => {
  logger.info("service_started", {
    port: config.webhookIngestorPort,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
