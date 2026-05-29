import { createServer, type ServerResponse } from "node:http";
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
  sendMetrics,
  type MetaTemplateSummary,
  type WhatsAppInteractiveSendRequest,
  type WhatsAppMarkReadRequest,
  type WhatsAppMediaSendRequest,
  type WhatsAppSendRequest,
  type WhatsAppSendResult,
  type WhatsAppTextSendRequest
} from "@hyfib/shared-core";
import {
  buildInteractiveBody,
  buildMarkReadBody,
  buildMediaBody,
  buildTemplateBody,
  buildTextBody,
  extractTemplateBody,
  mapMetaTemplateStatus
} from "./graph-messages.js";

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

// Simple circuit breaker shared across all Graph calls: after a run of
// failures we stop hammering the API for a cooldown window.
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const expo = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BASE_BACKOFF_MS);
  return Math.min(expo + jitter, 30_000);
}

async function rawGraphRequest(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  accessToken?: string
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`https://graph.facebook.com/${config.whatsappGraphVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken ?? config.whatsappAccessToken}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resilient Graph API call: opens a circuit breaker after repeated failures and
 * retries transient errors (429/5xx, network/timeouts) with exponential backoff
 * + jitter, honouring Retry-After. 4xx responses (other than 429) are returned
 * immediately since retrying them is pointless.
 */
async function graphRequest(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  accessToken?: string
): Promise<Response> {
  if (!accessToken && !config.whatsappAccessToken) {
    throw new Error("No WhatsApp access token configured (per-channel or env)");
  }
  if (Date.now() < breakerOpenUntil) {
    throw new Error("graph_circuit_open");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await rawGraphRequest(path, method, body, accessToken);
      if (response.status !== 429 && response.status < 500) {
        consecutiveFailures = 0;
        return response;
      }
      // Transient server-side error: back off and retry unless out of attempts.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffDelay(attempt, response.headers.get("retry-after")));
        continue;
      }
      registerFailure();
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffDelay(attempt, null));
        continue;
      }
    }
  }
  registerFailure();
  throw lastError instanceof Error ? lastError : new Error("graph_request_failed");
}

function registerFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    consecutiveFailures = 0;
    logger.warn("graph_circuit_opened", { cooldownMs: BREAKER_OPEN_MS });
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

/**
 * Shared send path for every message type: POST the built body to the contact's
 * messages edge, map a Graph error to 502 / circuit-open to 503, and return the
 * Meta message id on success.
 */
async function dispatchSend(
  res: ServerResponse,
  requestId: string,
  phoneNumberId: string,
  body: Record<string, unknown>,
  accessToken?: string
): Promise<void> {
  try {
    const response = await graphRequest(`/${phoneNumberId}/messages`, "POST", body, accessToken);
    if (!response.ok) {
      const graphError = await parseGraphError(response);
      logger.warn("meta_send_failed", { requestId, statusCode: response.status, graphError: graphError.message });
      sendJson(res, 502, { error: "meta_send_failed", details: graphError });
      return;
    }
    const parsed = (await response.json()) as { messages?: Array<{ id: string }> };
    const result: WhatsAppSendResult = { messageId: parsed.messages?.[0]?.id, status: "accepted" };
    sendJson(res, 202, { requestId, result });
  } catch (error) {
    logger.error("meta_send_exception", { requestId, error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 503, { error: "meta_adapter_unavailable" });
  }
}

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/metrics") {
    sendMetrics(res);
    return;
  }

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

    const graphBody = buildTemplateBody({
      to: payload.to,
      templateName: payload.templateName,
      templateLanguage: payload.templateLanguage,
      parameters: payload.parameters ?? [],
      components: payload.components
    });
    await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
    return;
  }

  if (path === "/internal/v1/whatsapp/send-text") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const payload = await readJsonBody<WhatsAppTextSendRequest>(req);
    if (!payload.phoneNumberId || !payload.to || !payload.text) {
      sendJson(res, 400, { error: "phoneNumberId, to and text are required" });
      return;
    }
    const graphBody = buildTextBody({ to: payload.to, text: payload.text, previewUrl: payload.previewUrl });
    await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
    return;
  }

  if (path === "/internal/v1/whatsapp/send-media") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const payload = await readJsonBody<WhatsAppMediaSendRequest>(req);
    if (!payload.phoneNumberId || !payload.to || !payload.mediaType || (!payload.link && !payload.mediaId)) {
      sendJson(res, 400, { error: "phoneNumberId, to, mediaType and one of link/mediaId are required" });
      return;
    }
    const graphBody = buildMediaBody({
      to: payload.to,
      mediaType: payload.mediaType,
      link: payload.link,
      mediaId: payload.mediaId,
      caption: payload.caption,
      filename: payload.filename
    });
    await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
    return;
  }

  if (path === "/internal/v1/whatsapp/send-interactive") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const payload = await readJsonBody<WhatsAppInteractiveSendRequest>(req);
    if (!payload.phoneNumberId || !payload.to || !payload.interactiveType || !payload.bodyText) {
      sendJson(res, 400, { error: "phoneNumberId, to, interactiveType and bodyText are required" });
      return;
    }
    const graphBody = buildInteractiveBody({
      to: payload.to,
      interactiveType: payload.interactiveType,
      bodyText: payload.bodyText,
      headerText: payload.headerText,
      footerText: payload.footerText,
      buttons: payload.buttons,
      buttonLabel: payload.buttonLabel,
      sections: payload.sections
    });
    await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
    return;
  }

  if (path === "/internal/v1/whatsapp/mark-read") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const payload = await readJsonBody<WhatsAppMarkReadRequest>(req);
    if (!payload.phoneNumberId || !payload.messageId) {
      sendJson(res, 400, { error: "phoneNumberId and messageId are required" });
      return;
    }
    try {
      const response = await graphRequest(
        `/${payload.phoneNumberId}/messages`,
        "POST",
        buildMarkReadBody(payload.messageId),
        payload.accessToken
      );
      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, { error: "meta_mark_read_failed", details: graphError });
        return;
      }
      sendJson(res, 200, { status: "read", messageId: payload.messageId });
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        details: error instanceof Error ? error.message : String(error)
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

  if (path === "/internal/v1/whatsapp/templates") {
    if (method !== "GET") {
      methodNotAllowed(res);
      return;
    }
    const query = parseQuery(req.url);
    const wabaId = query.get("wabaId") ?? config.whatsappWabaId;
    const accessToken = query.get("accessToken") ?? undefined;
    if (!wabaId) {
      sendJson(res, 400, { error: "wabaId is required" });
      return;
    }
    try {
      const response = await graphRequest(
        `/${wabaId}/message_templates?limit=200&fields=name,language,status,category,components`,
        "GET",
        undefined,
        accessToken
      );
      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, { error: "meta_templates_failed", details: graphError });
        return;
      }
      const body = (await response.json()) as {
        data?: Array<{ name?: string; language?: string; status?: string; category?: string; components?: unknown }>;
      };
      const templates: MetaTemplateSummary[] = (body.data ?? [])
        .filter((entry) => entry.name && entry.language)
        .map((entry) => ({
          name: entry.name!,
          language: entry.language!,
          status: mapMetaTemplateStatus(entry.status),
          category: entry.category ? entry.category.toLowerCase() : undefined,
          body: extractTemplateBody(entry.components)
        }));
      sendJson(res, 200, { items: templates });
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (path.startsWith("/internal/v1/whatsapp/media/")) {
    if (method !== "GET") {
      methodNotAllowed(res);
      return;
    }
    const mediaId = path.slice("/internal/v1/whatsapp/media/".length).trim();
    if (!mediaId) {
      sendJson(res, 400, { error: "mediaId is required" });
      return;
    }
    const query = parseQuery(req.url);
    const accessToken = query.get("accessToken") ?? undefined;
    try {
      const response = await graphRequest(`/${mediaId}`, "GET", undefined, accessToken);
      if (!response.ok) {
        const graphError = await parseGraphError(response);
        sendJson(res, 502, { error: "meta_media_failed", details: graphError });
        return;
      }
      // Returns { url, mime_type, sha256, file_size, id }. The URL itself must be
      // fetched with the bearer token by the caller (it is short-lived).
      const body = (await response.json()) as Record<string, unknown>;
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
