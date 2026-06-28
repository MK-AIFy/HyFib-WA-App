import { createServer } from "node:http";
import { createEventBus } from "@hyfib/event-bus";
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
  sendMetrics,
  incCounter,
  verifyMetaSignature
} from "@hyfib/shared-core";
import { normalizeInbound, normalizeStatus, type RawValue } from "./normalize.js";

interface WebhookPayload {
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: RawValue;
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
const eventBus = createEventBus(config);
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

async function ingest(
  payload: WebhookPayload,
  tenantId?: string
): Promise<{ inbound: number; statuses: number; duplicates: number }> {
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
        incCounter("events_published_total", "Events published to the bus.", {
          topic: EventTopics.WhatsAppInboundReceived
        });
        await eventBus.publish(
          EventTopics.WhatsAppInboundReceived,
          { ...normalizeInbound(value, message, entry.id) },
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
        incCounter("events_published_total", "Events published to the bus.", {
          topic: EventTopics.WhatsAppStatusUpdated
        });
        await eventBus.publish(
          EventTopics.WhatsAppStatusUpdated,
          { ...normalizeStatus(value, status, entry.id) },
          tenantId
        );
      }
    }
  }

  return { inbound, statuses, duplicates };
}

const server = createServer(async (req, res) => {
  try {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/metrics") {
    sendMetrics(res);
    return;
  }

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

    const providedSecret = typeof req.headers["x-internal-secret"] === "string"
      ? req.headers["x-internal-secret"]
      : "";
    if (config.internalServiceSecret !== "" && providedSecret !== config.internalServiceSecret) {
      logger.warn("replay_unauthorized", { requestId: ctx.requestId });
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const raw = await readRawBody(req);
    const payload = safeJsonParse(raw);
    const summary = await ingest(payload, ctx.tenantId);

    logger.info("webhook_replayed", {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      inbound: summary.inbound,
      statuses: summary.statuses,
      duplicates: summary.duplicates
    });

    sendJson(res, 200, {
      status: "replayed",
      requestId: ctx.requestId,
      ...summary
    });
    return;
  }

  notFound(res);
  } catch (error) {
    logger.error("webhook_handler_error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_server_error" });
    }
  }
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
