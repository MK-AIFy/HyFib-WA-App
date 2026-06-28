import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { waitForReady, withAdmin } from "@hyfib/db";
import { consume } from "@hyfib/queue";
import { EventTopics, Logger, parseUrlPath, requestContext, sendJson, sendMetrics, incCounter } from "@hyfib/shared-core";

interface AuditEventPayload {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  payload?: Record<string, unknown>;
}

const config = loadConfig();
const logger = new Logger("audit-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.auditServicePort;

async function persistEvent(tenantId: string | undefined, evt: AuditEventPayload): Promise<void> {
  if (!evt.action || !evt.resourceType) {
    return;
  }
  const action = evt.action;
  const resourceType = evt.resourceType;
  const resourceId = evt.resourceId ?? null;
  const payloadJson = JSON.stringify({ ...(evt.payload ?? {}), actorId: evt.actorId ?? null });
  await withAdmin(async (tx) => {
    await tx.query(
      `INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, payload)
       VALUES ($1, NULL, $2, $3, $4, $5::jsonb)`,
      [tenantId ?? null, action, resourceType, resourceId, payloadJson]
    );
    incCounter("audit_events_persisted_total", "Audit events persisted.", { action });
  });
}

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const method = req.method ?? "GET";
    const ctx = requestContext(req);

    if (path === "/health") {
      sendJson(res, 200, { service: "audit-service", status: "ok", timestamp: new Date().toISOString() });
      return;
    }

    if (path === "/metrics") {
      sendMetrics(res);
      return;
    }

    sendJson(res, 404, {
      error: "route_not_found",
      service: "audit-service",
      method,
      path,
      requestId: ctx.requestId
    });
  } catch (error) {
    logger.error("request_handler_error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_server_error" });
    }
  }
});

async function startConsumers(): Promise<void> {
  await consume(
    { service: "audit-service", topics: [EventTopics.AuditEventRecorded] },
    async (received) => {
      try {
        await persistEvent(received.tenantId, received.payload as AuditEventPayload);
        logger.info("audit_event_persisted", {
          tenantId: received.tenantId,
          action: (received.payload as AuditEventPayload).action
        });
      } catch (error) {
        logger.error("audit_persist_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  );
}

async function bootstrap(): Promise<void> {
  await waitForReady().catch((err) =>
    logger.warn("db_wait_failed", { error: err instanceof Error ? err.message : String(err) })
  );
  server.listen(port, () => {
    logger.info("service_started", { port, nodeEnv: config.nodeEnv });
  });
  startConsumers().catch((error) => {
    logger.error("consumer_setup_failed", { error: error instanceof Error ? error.message : String(error) });
  });
}

server.on("error", (error) => {
  logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
});

void bootstrap();
