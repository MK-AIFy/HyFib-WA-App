import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { query, waitForReady, withAdmin } from "@hyfib/db";
import {
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readJsonBody,
  requestContext,
  sendJson,
  sendMetrics
} from "@hyfib/shared-core";

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface CreateTenantBody {
  name?: string;
}

const config = loadConfig();
const logger = new Logger("tenant-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.tenantServicePort;

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const method = req.method ?? "GET";
    const ctx = requestContext(req);

    if (path === "/health") {
      sendJson(res, 200, { service: "tenant-service", status: "ok", timestamp: new Date().toISOString() });
      return;
    }

    if (path === "/metrics") {
      sendMetrics(res);
      return;
    }

    if (path.startsWith("/internal") && req.headers["x-internal-secret"] !== config.internalServiceSecret) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (path === "/internal/v1/tenants") {
      if (method === "GET") {
        const rows = await query<TenantRow>(
          `SELECT id, name, status, created_at FROM tenants ORDER BY created_at DESC LIMIT 200`
        );
        sendJson(res, 200, {
          items: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at }))
        });
        return;
      }

      if (method === "POST") {
        const body = await readJsonBody<CreateTenantBody>(req);
        if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
          sendJson(res, 400, { error: "name required" });
          return;
        }
        const name = body.name.trim().slice(0, 256);
        const created = await withAdmin((tx) =>
          tx.queryOne<TenantRow>(
            `INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, status, created_at`,
            [name]
          )
        );
        if (!created) {
          sendJson(res, 500, { error: "insert_failed" });
          return;
        }
        logger.info("tenant_created", { requestId: ctx.requestId, tenantId: created.id, name });
        sendJson(res, 201, {
          id: created.id,
          name: created.name,
          status: created.status,
          createdAt: created.created_at
        });
        return;
      }

      methodNotAllowed(res);
      return;
    }

    notFound(res);
  } catch (error) {
    logger.error("request_handler_error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_server_error" });
    }
  }
});

async function bootstrap(): Promise<void> {
  await waitForReady().catch((err) =>
    logger.warn("db_wait_failed", { error: err instanceof Error ? err.message : String(err) })
  );
  server.listen(port, () => {
    logger.info("service_started", { port, nodeEnv: config.nodeEnv });
  });
}

server.on("error", (error) => {
  logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
});

void bootstrap();
