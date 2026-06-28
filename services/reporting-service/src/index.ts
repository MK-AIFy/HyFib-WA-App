import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { waitForReady, withTenant } from "@hyfib/db";
import { Logger, notFound, parseUrlPath, requestContext, sendJson, sendMetrics } from "@hyfib/shared-core";

interface CountsRow {
  conversations: string;
  contacts: string;
  templates: string;
  campaigns: string;
  inbound: string;
  outbound: string;
  failed: string;
}

interface DailyRow {
  bucket_date: string;
  n: string;
}

const config = loadConfig();
const logger = new Logger("reporting-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.reportingServicePort;

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const ctx = requestContext(req);
    const tenantId = ctx.tenantId;

    if (path === "/health") {
      sendJson(res, 200, { service: "reporting-service", status: "ok", timestamp: new Date().toISOString() });
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

    if (path === "/internal/v1/reports/overview") {
      if (!tenantId) {
        sendJson(res, 400, { error: "x-tenant-id required" });
        return;
      }

      const data = await withTenant(tenantId, async (tx) => {
        const counts = await tx.queryOne<CountsRow>(
          `SELECT
            (SELECT COUNT(*)::text FROM conversations) AS conversations,
            (SELECT COUNT(*)::text FROM contacts)      AS contacts,
            (SELECT COUNT(*)::text FROM templates)     AS templates,
            (SELECT COUNT(*)::text FROM campaigns)     AS campaigns,
            (SELECT COUNT(*)::text FROM messages WHERE direction='inbound')  AS inbound,
            (SELECT COUNT(*)::text FROM messages WHERE direction='outbound') AS outbound,
            (SELECT COUNT(*)::text FROM messages WHERE status='failed')      AS failed`
        );
        const dailyRows = await tx.query<DailyRow>(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket_date,
                  COUNT(*)::text AS n
             FROM messages
            WHERE created_at >= now() - INTERVAL '14 days'
            GROUP BY 1
            ORDER BY 1 DESC`
        );
        return {
          totals: counts
            ? {
                conversations: Number(counts.conversations),
                contacts: Number(counts.contacts),
                templates: Number(counts.templates),
                campaigns: Number(counts.campaigns),
                messagesInbound: Number(counts.inbound),
                messagesOutbound: Number(counts.outbound),
                messagesFailed: Number(counts.failed)
              }
            : {},
          last14Days: dailyRows.map((r) => ({ date: r.bucket_date, count: Number(r.n) }))
        };
      });

      sendJson(res, 200, { tenantId, ...data });
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
