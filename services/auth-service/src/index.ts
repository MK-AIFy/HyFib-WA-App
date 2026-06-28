import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
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

interface AuthorizeBody {
  requiredRoles?: string[];
}

const config = loadConfig();
const logger = new Logger("auth-service", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.authServicePort;

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const method = req.method ?? "GET";
    const ctx = requestContext(req);

    if (path === "/health") {
      sendJson(res, 200, {
        service: "auth-service",
        status: "ok",
        realm: config.keycloak.realm,
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

    if (path === "/internal/v1/auth/authorize") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }

      const payload = await readJsonBody<AuthorizeBody>(req);
      const currentRole = req.headers["x-role"];
      const normalized = typeof currentRole === "string" ? currentRole : undefined;
      const authorized =
        !!normalized &&
        Array.isArray(payload.requiredRoles) &&
        payload.requiredRoles.includes(normalized);

      logger.info("authorize_checked", {
        requestId: ctx.requestId,
        authorized,
        role: normalized
      });

      sendJson(res, authorized ? 200 : 403, {
        requestId: ctx.requestId,
        authorized,
        role: normalized,
        requiredRoles: payload.requiredRoles
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

server.listen(port, () => {
  logger.info("service_started", { port, nodeEnv: config.nodeEnv });
});

server.on("error", (error) => {
  logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
});
