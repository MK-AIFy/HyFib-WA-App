import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "@hyfib/config";
import {
  Logger,
  methodNotAllowed,
  notFound,
  parseQuery,
  parseUrlPath,
  readJsonBody,
  requestContext,
  sendJson,
  type WhatsAppSendRequest,
  type WhatsAppSendResult
} from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("meta-adapter", config.logLevel as "debug" | "info" | "warn" | "error");
const port = config.metaAdapterPort;

interface RegisterNumberRequest {
  phoneNumberId?: string;
  pin?: string;
}

interface SubscribeAppRequest {
  wabaId?: string;
}

interface GraphError {
  message: string;
  code?: number;
}

async function graphRequest(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<Response> {
  if (!config.whatsappAccessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(`https://graph.facebook.com/${config.whatsappGraphVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseGraphError(response: Response): Promise<GraphError> {
  try {
    const payload = (await response.json()) as {
      error?: {
        message?: string;
        code?: number;
      };
    };

    if (payload.error?.message) {
      return { message: payload.error.message, code: payload.error.code };
    }
  } catch {
    // ignore non-json
  }

  return { message: `Graph API failed with status ${response.status}` };
}

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "meta-adapter",
      status: "ok",
      graphVersion: config.whatsappGraphVersion,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/internal/v1/whatsapp/send-template") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<WhatsAppSendRequest>(req);
    if (!payload.phoneNumberId || !payload.to || !payload.templateName || !payload.templateLanguage) {
      sendJson(res, 400, { error: "Missing required fields for template send" });
      return;
    }

    const graphBody = {
      messaging_product: "whatsapp",
      to: payload.to,
      type: "template",
      template: {
        name: payload.templateName,
        language: {
          code: payload.templateLanguage
        },
        components: payload.parameters.length
          ? [
              {
                type: "body",
                parameters: payload.parameters.map((text) => ({
                  type: "text",
                  text
                }))
              }
            ]
          : undefined
      }
    };

    try {
      const response = await graphRequest(`/${payload.phoneNumberId}/messages`, "POST", graphBody);
      if (!response.ok) {
        const graphError = await parseGraphError(response);
        logger.warn("meta_send_failed", {
          requestId: ctx.requestId,
          statusCode: response.status,
          graphError: graphError.message
        });
        sendJson(res, 502, {
          error: "meta_send_failed",
          details: graphError
        });
        return;
      }

      const body = (await response.json()) as {
        messages?: Array<{ id: string }>;
      };

      const result: WhatsAppSendResult = {
        messageId: body.messages?.[0]?.id,
        status: "accepted"
      };

      sendJson(res, 202, {
        requestId: ctx.requestId,
        result
      });
    } catch (error) {
      logger.error("meta_send_exception", {
        requestId: ctx.requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      sendJson(res, 503, {
        error: "meta_adapter_unavailable"
      });
    }
    return;
  }

  if (path === "/internal/v1/whatsapp/register-number") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<RegisterNumberRequest>(req);
    const phoneNumberId = payload.phoneNumberId ?? config.whatsappPhoneNumberId;
    const pin = payload.pin ?? config.whatsappRegisterPin;

    if (!phoneNumberId || !pin) {
      sendJson(res, 400, { error: "phoneNumberId and pin are required" });
      return;
    }

    try {
      const response = await graphRequest(`/${phoneNumberId}/register`, "POST", {
        messaging_product: "whatsapp",
        pin
      });

      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, {
          error: "meta_register_failed",
          details: graphError
        });
        return;
      }

      sendJson(res, 200, {
        status: "registered",
        phoneNumberId
      });
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (path === "/internal/v1/whatsapp/subscribe-app") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<SubscribeAppRequest>(req);
    const wabaId = payload.wabaId ?? config.whatsappWabaId;
    if (!wabaId) {
      sendJson(res, 400, { error: "wabaId is required" });
      return;
    }

    try {
      const response = await graphRequest(`/${wabaId}/subscribed_apps`, "POST", {});
      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, {
          error: "meta_subscribe_failed",
          details: graphError
        });
        return;
      }

      sendJson(res, 200, { status: "subscribed", wabaId });
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (path === "/internal/v1/whatsapp/phone-numbers") {
    if (method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const query = parseQuery(req.url);
    const wabaId = query.get("wabaId") ?? config.whatsappWabaId;
    if (!wabaId) {
      sendJson(res, 400, { error: "wabaId is required" });
      return;
    }

    try {
      const response = await graphRequest(`/${wabaId}/phone_numbers`, "GET");
      const body = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, {
          error: "meta_phone_numbers_failed",
          details: graphError
        });
        return;
      }

      sendJson(res, 200, body);
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (path === "/internal/v1/whatsapp/rate-limit-probe") {
    // Operational endpoint to test external dependency availability without sending messages.
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    await delay(100);
    sendJson(res, 200, {
      status: "ok",
      message: "Probe completed"
    });
    return;
  }

  notFound(res);
});

server.listen(port, () => {
  logger.info("service_started", { port, nodeEnv: config.nodeEnv });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
