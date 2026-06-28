import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { waitForReady, withTenant } from "@hyfib/db";
import {
  Logger,
  methodNotAllowed,
  notFound,
  parseQuery,
  parseUrlPath,
  requestContext,
  sendJson,
  sendMetrics
} from "@hyfib/shared-core";

interface UsageRow {
  bucket_date: string;
  direction: string;
  category: string;
  n: string;
}

const config = loadConfig();
const logger = new Logger("billing-usage-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.billingUsageServicePort;

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const method = req.method ?? "GET";
    const ctx = requestContext(req);
    const tenantId = ctx.tenantId;

    if (path === "/health") {
      sendJson(res, 200, {
        service: "billing-usage-service",
        status: "ok",
        timestamp: new Date().toISOString()
      });
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

    if (path === "/internal/v1/usage") {
      if (method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      if (!tenantId) {
        sendJson(res, 400, { error: "x-tenant-id required" });
        return;
      }

      const q = parseQuery(req.url);
      const days = Math.max(1, Math.min(90, Number(q.get("days") ?? "7")));

      const rows = await withTenant(tenantId, (tx) =>
        tx.query<UsageRow>(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket_date,
                  direction,
                  COALESCE(category, 'none') AS category,
                  COUNT(*)::text AS n
             FROM messages
            WHERE created_at >= now() - ($1 || ' days')::interval
            GROUP BY 1, 2, 3
            ORDER BY 1 DESC`,
          [String(days)]
        )
      );

      sendJson(res, 200, {
        tenantId,
        days,
        items: rows.map((r) => ({
          date: r.bucket_date,
          direction: r.direction,
          category: r.category,
          count: Number(r.n)
        }))
      });
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
