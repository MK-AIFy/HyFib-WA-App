import { createServer } from "node:http";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Cross-entity reporting overview for a tenant. Exported so app-server calls it
 * directly in-process; the standalone service's endpoint wraps it.
 */
export async function getReportsOverview(tenantId: string): Promise<Record<string, unknown>> {
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
  return { tenantId, ...data };
}

interface MetricRow {
  user_id: string;
  n: string;
  avg_minutes: string | null;
}

/**
 * Per-agent performance (roadmap G11): messages sent, conversations closed +
 * average resolution time, and first-response counts/times. Attribution comes
 * from messages.sender_user_id (stamped on human conversation sends, absent on
 * automations) and conversations.closed_at/closed_by_user_id (migration 028).
 * Every active user appears, zero-filled, so an idle agent is visible rather
 * than missing. Exported so app-server calls it in-process.
 */
export async function getAgentPerformance(tenantId: string, days: number): Promise<Record<string, unknown>> {
  const clamped = Math.min(Math.max(Math.trunc(days) || 30, 1), 90);
  const data = await withTenant(tenantId, async (tx) => {
    const sent = await tx.query<MetricRow>(
      `SELECT sender_user_id AS user_id, COUNT(*)::text AS n, NULL AS avg_minutes
         FROM messages
        WHERE direction = 'outbound' AND sender_user_id IS NOT NULL
          AND created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1`,
      [String(clamped)]
    );
    const closed = await tx.query<MetricRow>(
      `SELECT closed_by_user_id AS user_id, COUNT(*)::text AS n,
              avg(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60)::text AS avg_minutes
         FROM conversations
        WHERE closed_by_user_id IS NOT NULL
          AND closed_at >= now() - ($1 || ' days')::interval
        GROUP BY 1`,
      [String(clamped)]
    );
    // First response: per conversation, the earliest attributed outbound after
    // the earliest inbound; credited to the agent who sent it.
    const frt = await tx.query<MetricRow>(
      `WITH firsts AS (
         SELECT conversation_id,
                MIN(created_at) FILTER (WHERE direction = 'inbound') AS first_in,
                MIN(created_at) FILTER (WHERE direction = 'outbound' AND sender_user_id IS NOT NULL) AS first_out
           FROM messages
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY conversation_id
       )
       SELECT m.sender_user_id AS user_id, COUNT(*)::text AS n,
              avg(EXTRACT(EPOCH FROM (f.first_out - f.first_in)) / 60)::text AS avg_minutes
         FROM firsts f
         JOIN messages m
           ON m.conversation_id = f.conversation_id
          AND m.created_at = f.first_out
          AND m.direction = 'outbound'
          AND m.sender_user_id IS NOT NULL
        WHERE f.first_in IS NOT NULL AND f.first_out > f.first_in
        GROUP BY 1`,
      [String(clamped)]
    );
    const users = await tx.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE status = 'active' ORDER BY display_name ASC"
    );

    const index = (rows: MetricRow[]): Map<string, { n: number; avg: number | null }> => {
      const map = new Map<string, { n: number; avg: number | null }>();
      for (const row of rows) {
        map.set(row.user_id, { n: Number(row.n), avg: row.avg_minutes === null ? null : Number(row.avg_minutes) });
      }
      return map;
    };
    const sentBy = index(sent);
    const closedBy = index(closed);
    const frtBy = index(frt);

    const round = (value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : Math.round(value * 10) / 10;

    return users.map((user) => ({
      userId: user.id,
      displayName: user.display_name,
      messagesSent: sentBy.get(user.id)?.n ?? 0,
      conversationsClosed: closedBy.get(user.id)?.n ?? 0,
      avgResolutionMinutes: round(closedBy.get(user.id)?.avg),
      firstResponses: frtBy.get(user.id)?.n ?? 0,
      avgFirstResponseMinutes: round(frtBy.get(user.id)?.avg)
    }));
  });
  return { tenantId, days: clamped, agents: data };
}

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
      sendJson(res, 200, await getReportsOverview(tenantId));
      return;
    }

    if (path === "/internal/v1/reports/agents") {
      if (!tenantId) {
        sendJson(res, 400, { error: "x-tenant-id required" });
        return;
      }
      const days = Number(new URL(req.url ?? "/", "http://local").searchParams.get("days") ?? "30");
      sendJson(res, 200, await getAgentPerformance(tenantId, days));
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

// Boot the standalone service only when executed directly, never when imported
// by app-server for its exported getReportsOverview function.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void bootstrap();
}
