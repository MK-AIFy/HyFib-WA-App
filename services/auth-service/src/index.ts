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
  type Role
} from "@hyfib/shared-core";

interface AuthorizeRequest {
  requiredRoles: Role[];
}

const config = loadConfig();
const logger = new Logger("auth-service", config.logLevel as "debug" | "info" | "warn" | "error");

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "auth-service",
      status: "ok",
      realm: process.env.KEYCLOAK_REALM ?? "hyfib-wa",
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/internal/v1/auth/authorize") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<AuthorizeRequest>(req);
    const currentRole = req.headers["x-role"];
    const normalized = typeof currentRole === "string" ? (currentRole as Role) : undefined;

    const authorized = !!normalized && Array.isArray(payload.requiredRoles) && payload.requiredRoles.includes(normalized);
    sendJson(res, authorized ? 200 : 403, {
      requestId: ctx.requestId,
      authorized,
      role: normalized,
      requiredRoles: payload.requiredRoles
    });
    return;
  }

  notFound(res);
});

server.listen(config.authServicePort, () => {
  logger.info("service_started", {
    port: config.authServicePort,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
