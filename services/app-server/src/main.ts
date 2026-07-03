import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import { waitForReady, closePool as closeDbPool } from "@hyfib/db";
import { closePool as closePersistencePool } from "@hyfib/persistence";
import { closeRedis } from "@hyfib/ratelimit";
import { createEventBus, type EventBus } from "@hyfib/event-bus";
import { Logger, parseUrlPath, sendJson, sendMetrics } from "@hyfib/shared-core";

export interface AppServerDeps {
  logger: Logger;
  eventBus: EventBus;
}

/**
 * Root request router for the modular monolith. Phase 1 serves only the
 * operational endpoints; feature modules (gateway `/api` + `/auth`, worker
 * schedulers, …) are wired in at the marked seam in later phases.
 */
export function createAppRequestHandler(
  _deps: AppServerDeps
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = parseUrlPath(req.url);
    if (path === "/health") {
      sendJson(res, 200, { service: "app-server", status: "ok", timestamp: new Date().toISOString() });
      return;
    }
    if (path === "/metrics") {
      sendMetrics(res);
      return;
    }
    // ── Feature modules mount here (Phase 2+): gateway /api + /auth, /r/*, webhooks ──
    sendJson(res, 404, { error: "route_not_found" });
  };
}

export interface AppServer {
  server: Server;
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Composes the HTTP server from injected dependencies. Kept side-effect free
 * (no `listen`, no DB connect) so tests can exercise the router directly.
 */
export function createAppServer(deps: AppServerDeps): AppServer {
  const handler = createAppRequestHandler(deps);
  const server = createServer((req, res) => handler(req, res));

  const shutdown = async (signal: string): Promise<void> => {
    deps.logger.info("shutdown_started", { signal });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await deps.eventBus.close().catch(() => undefined);
    await closePersistencePool().catch(() => undefined);
    await closeDbPool().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    deps.logger.info("shutdown_complete", { signal });
  };

  return { server, shutdown };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("app-server", config.logLevel as "debug" | "info" | "warn" | "error");

  await waitForReady();

  const eventBus = createEventBus(config);
  const { server, shutdown } = createAppServer({ logger, eventBus });

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
