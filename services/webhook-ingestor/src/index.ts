import { createServer } from "node:http";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import {
  RedisIdempotencyStore,
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readRawBody,
  requestContext,
  sendJson,
  sendMetrics,
  verifyMetaSignature
} from "@hyfib/shared-core";
import { getRedisClient } from "@hyfib/ratelimit";
import { ingestMetaWebhook, safeJsonParse, deriveTenantId, type ForwardedWebhook } from "./ingest.js";

export * from "./ingest.js";

const config = loadConfig();
const logger = new Logger("webhook-ingestor", config.logLevel as "debug" | "info" | "warn" | "error");
const eventBus = createEventBus(config);
const idempotency = new RedisIdempotencyStore(getRedisClient(config), 24 * 60 * 60);
const ingestDeps = { eventBus, idempotency };

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
      const forwarded = safeJsonParse(raw) as unknown as ForwardedWebhook;
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
    const summary = await ingestMetaWebhook(payload, scopedTenant, ingestDeps);

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
    const summary = await ingestMetaWebhook(payload, ctx.tenantId, ingestDeps);

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

// Boot the standalone HTTP service only when executed directly, never when
// the package is imported by app-server for its exported ingest functions.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
}
