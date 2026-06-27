import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import { Logger, parseUrlPath, sendMetrics } from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("web-portal", config.logLevel as "debug" | "info" | "warn" | "error");
const port = 3000;

// Gateway is on the same Docker network; falls back to localhost for local dev outside Docker.
const GATEWAY_HOST = process.env.API_GATEWAY_HOST ?? "api-gateway";
const GATEWAY_PORT = config.apiGatewayPort ?? 8080;

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");

function proxyToGateway(req: IncomingMessage, res: ServerResponse): void {
  const options = {
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${GATEWAY_HOST}:${GATEWAY_PORT}` }
  };
  const proxy = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", (err) => {
    logger.error("proxy_error", { error: err.message, path: req.url });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway unavailable" }));
    }
  });
  req.pipe(proxy, { end: true });
}

const server = createServer((req, res) => {
  const path = parseUrlPath(req.url);

  // Proxy all API and webhook traffic to the gateway.
  if (req.url?.startsWith("/api/")) {
    proxyToGateway(req, res);
    return;
  }

  if (path === "/metrics") {
    sendMetrics(res);
    return;
  }

  if (path === "/health") {
    const payload = JSON.stringify({
      service: "web-portal",
      status: "ok",
      timestamp: new Date().toISOString()
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(payload);
    return;
  }

  if (path === "/" || path === "/index.html") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Not found" }));
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
