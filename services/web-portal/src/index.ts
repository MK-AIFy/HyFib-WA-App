import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import { Logger, parseUrlPath, sendMetrics } from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("web-portal", config.logLevel as "debug" | "info" | "warn" | "error");
const port = 3000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");

const server = createServer((req, res) => {
  const path = parseUrlPath(req.url);

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
