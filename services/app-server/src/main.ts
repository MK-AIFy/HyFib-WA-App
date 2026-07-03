import { createServer, type Server } from "node:http";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import { waitForReady, closePool as closeDbPool } from "@hyfib/db";
import { closePool as closePersistencePool } from "@hyfib/persistence";
import { closeRedis } from "@hyfib/ratelimit";
import { createEventBus, type EventBus } from "@hyfib/event-bus";
import { createGatewayHandler, type GatewayModule, type IngestWebhookProxy } from "@hyfib/api-gateway";
import { processForwardedWebhook } from "@hyfib/webhook-ingestor";
import { getRedisClient } from "@hyfib/ratelimit";
import { Logger, RedisIdempotencyStore, sendJson } from "@hyfib/shared-core";

export interface AppServerDeps {
  logger: Logger;
  eventBus: EventBus;
  /** Direct in-process webhook ingestion; when omitted the gateway proxies over HTTP. */
  proxyWebhookToIngestor?: IngestWebhookProxy;
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
    proxyWebhookToIngestor: deps.proxyWebhookToIngestor
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
  // proxying to the webhook-ingestor over HTTP. Publishes on the shared bus.
  const webhookIdempotency = new RedisIdempotencyStore(getRedisClient(config), 24 * 60 * 60);
  const proxyWebhookToIngestor: IngestWebhookProxy = async (forwarded) => {
    const { verified, summary } = await processForwardedWebhook(forwarded, {
      eventBus,
      idempotency: webhookIdempotency,
      metaAppSecret: config.metaAppSecret
    });
    return { ok: verified, body: { status: verified ? "accepted" : "invalid_signature", ...summary } };
  };

  const { server, gateway, shutdown } = createAppServer({ logger, eventBus, proxyWebhookToIngestor });

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
