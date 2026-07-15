import { createServer, type Server } from "node:http";
import { argv } from "node:process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import { waitForReady, closePool as closeDbPool } from "@hyfib/db";
import {
  closePool as closePersistencePool,
  outboxRepository,
  resolveChannelByPhoneNumberId,
  withTenant
} from "@hyfib/persistence";
import { closeRedis, getRedisClient } from "@hyfib/ratelimit";
import { createEventBus, type EventBus } from "@hyfib/event-bus";
import {
  createGatewayHandler,
  type GatewayModule,
  type IngestWebhookProxy,
  type ReportsOverviewProxy,
  type UsageProxy,
  type AiProxy,
  type SendTypingIndicatorProxy
} from "@hyfib/api-gateway";
import { processForwardedWebhook } from "@hyfib/webhook-ingestor";
import { createDurableWebhookBus } from "./webhook-outbox-bus.js";
import { createIngestWebhookProxy } from "./ingest-proxy.js";
import { fetchMediaDirect, metaDispatch } from "@hyfib/meta-adapter";
import { registerWorkerConsumers, type WorkerMetaClient } from "@hyfib/notification-worker";
import { getReportsOverview } from "@hyfib/reporting-service";
import { getUsage } from "@hyfib/billing-usage-service";
import { dispatchAi } from "@hyfib/ai-intelligence-service";
import { Logger, RedisIdempotencyStore, sendJson } from "@hyfib/shared-core";

export interface AppServerDeps {
  logger: Logger;
  eventBus: EventBus;
  /** Direct in-process webhook ingestion; when omitted the gateway proxies over HTTP. */
  proxyWebhookToIngestor?: IngestWebhookProxy;
  /** Direct in-process reports/usage/AI; when omitted the gateway proxies over HTTP. */
  proxyReportsOverview?: ReportsOverviewProxy;
  proxyUsage?: UsageProxy;
  proxyAi?: AiProxy;
  /** Direct in-process typing-indicator send; when omitted the gateway proxies over HTTP. */
  proxySendTypingIndicator?: SendTypingIndicatorProxy;
}

export interface AppServer {
  server: Server;
  gateway: GatewayModule;
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Composes the HTTP server for the modular monolith. The gateway module owns
 * the entire external HTTP surface (`/api`, `/auth`, `/r`, webhooks, `/health`,
 * `/metrics`), wired onto the shared event bus so in-process worker consumers
 * (Phase 5+) observe gateway-published events. Kept side-effect free (no
 * `listen`, no schedulers, no DB connect) so tests can exercise the router.
 */
export function createAppServer(deps: AppServerDeps): AppServer {
  const gateway = createGatewayHandler({
    eventBus: deps.eventBus,
    proxyWebhookToIngestor: deps.proxyWebhookToIngestor,
    proxyReportsOverview: deps.proxyReportsOverview,
    proxyUsage: deps.proxyUsage,
    proxyAi: deps.proxyAi,
    proxySendTypingIndicator: deps.proxySendTypingIndicator
  });

  const server = createServer((req, res) => {
    gateway.applySecurityHeaders(res);
    gateway.handle(req, res).catch((error) => {
      deps.logger.error("request_failed", {
        method: req.method,
        url: req.url,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    deps.logger.info("shutdown_started", { signal });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await gateway.close().catch(() => undefined);
    await closePersistencePool().catch(() => undefined);
    await closeDbPool().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    deps.logger.info("shutdown_complete", { signal });
  };

  return { server, gateway, shutdown };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("app-server", config.logLevel as "debug" | "info" | "warn" | "error");

  await waitForReady();

  const eventBus = createEventBus(config);

  // Direct in-process webhook ingestion: the gateway calls this instead of
  // proxying to the webhook-ingestor over HTTP. Publishes route through the
  // durable DB outbox (crash-safe, retried with backoff, dead-letterable via
  // the gateway's relay) instead of straight onto the shared bus — a
  // composition-only decorator; webhook-ingestor's own EventBus interface is
  // untouched. Worker registration and gateway/SSE fan-out below keep using
  // the raw shared bus.
  const webhookIdempotency = new RedisIdempotencyStore(getRedisClient(config), 24 * 60 * 60);
  const durableWebhookBus = createDurableWebhookBus(eventBus, {
    resolveTenant: async (phoneNumberId) => (await resolveChannelByPhoneNumberId(phoneNumberId))?.tenantId,
    enqueue: (tenantId, topic, payload) =>
      withTenant(tenantId, (client) =>
        outboxRepository.enqueue(client, tenantId, { topic, payload: payload as Record<string, unknown> })
      ),
    logger
  });
  const proxyWebhookToIngestor: IngestWebhookProxy = createIngestWebhookProxy((forwarded) =>
    processForwardedWebhook(forwarded, {
      eventBus: durableWebhookBus,
      idempotency: webhookIdempotency,
      metaAppSecret: config.metaAppSecret,
      logger
    })
  );

  const { server, gateway, shutdown } = createAppServer({
    logger,
    eventBus,
    proxyWebhookToIngestor,
    // Direct in-process calls to the former read/AI services (no HTTP hop).
    proxyReportsOverview: async (ctx) => ({ status: 200, body: await getReportsOverview(ctx.tenantId) }),
    proxyUsage: async (ctx, days) => ({ status: 200, body: await getUsage(ctx.tenantId, days) }),
    proxyAi: async (ctx, aiPath, method, rawBody) => dispatchAi(aiPath, method, rawBody, ctx.requestId),
    proxySendTypingIndicator: async (params) => {
      const { status, body } = await metaDispatch("/internal/v1/whatsapp/send-typing", params, randomUUID());
      return { status, body: body as Record<string, unknown> };
    }
  });

  // Register worker consumers on the shared bus with a direct in-process meta
  // transport (no HTTP hop to the meta-adapter). Durable delivery is provided
  // by the gateway's outbox relay (started below) + idempotent handlers.
  const workerMetaClient: WorkerMetaClient = {
    async send(endpoint, _tenantId, payload) {
      const { status, body } = await metaDispatch(endpoint, payload, randomUUID());
      if (status !== 202) {
        throw new Error(`meta_adapter_rejected_${status}`);
      }
      const result = (body as { result?: { messageId?: string; status?: string } }).result;
      return { messageId: result?.messageId, accepted: result?.status === "accepted" };
    },
    async markRead(phoneNumberId, messageId, _tenantId, accessToken) {
      await metaDispatch("/internal/v1/whatsapp/mark-read", { phoneNumberId, messageId, accessToken }, randomUUID());
    },
    async fetchMedia(mediaId, _tenantId, accessToken) {
      const result = await fetchMediaDirect(mediaId, accessToken, { requestId: randomUUID() });
      if (!result.media) {
        throw new Error(`meta_adapter_media_fetch_failed_${result.status}${result.error ? `_${result.error}` : ""}`);
      }
      return {
        buffer: result.media.buffer,
        mimeType: result.media.mimeType,
        fileSizeBytes: result.media.fileSizeBytes
      };
    }
  };
  registerWorkerConsumers({ eventBus, metaClient: workerMetaClient });

  const schedulerTimers = gateway.startSchedulers();
  await gateway.bootstrapPlatformAdmin();

  server.listen(config.appServerPort, () => {
    logger.info("service_started", {
      port: config.appServerPort,
      nodeEnv: config.nodeEnv,
      eventBus: config.eventBus
    });
  });

  server.on("error", (error) => {
    logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
  });

  const onSignal = (signal: string): void => {
    for (const timer of schedulerTimers) {
      clearInterval(timer);
    }
    void shutdown(signal).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

// Boot only when executed as the entrypoint (relative or absolute path),
// never when imported by tests.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "fatal_boot_error",
        error: error instanceof Error ? error.message : String(error)
      })}\n`
    );
    process.exit(1);
  });
}
