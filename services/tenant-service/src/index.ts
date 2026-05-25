import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { Logger, notFound, parseUrlPath, requestContext, sendJson } from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("tenant-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.tenantServicePort;

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "tenant-service",
      status: "ok",
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/metrics") {
    sendJson(res, 200, {
      service: "tenant-service",
      uptimeSeconds: Number(process.uptime().toFixed(0)),
      memoryRssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2))
    });
    return;
  }

  sendJson(res, 404, {
    error: "route_not_found",
    service: "tenant-service",
    method,
    path,
    requestId: ctx.requestId
  });
});

server.listen(port, () => {
  logger.info("service_started", {
    port,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
