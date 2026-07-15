import { createServer, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import {
  Logger,
  methodNotAllowed,
  notFound,
  parseQuery,
  parseUrlPath,
  readBinaryBody,
  readJsonBody,
  requestContext,
  sendJson,
  sendMetrics,
  type MetaTemplateSummary,
  type WhatsAppContactCard,
  type WhatsAppInteractiveSendRequest,
  type WhatsAppMarkReadRequest,
  type WhatsAppMediaSendRequest,
  type WhatsAppSendRequest,
  type WhatsAppSendResult,
  type WhatsAppTextSendRequest
} from "@hyfib/shared-core";
import {
  buildCatalogMessage,
  buildContactsBody,
  buildFlowMessage,
  buildInteractiveBody,
  buildLocationBody,
  buildMarkReadBody,
  buildMediaBody,
  buildMediaUploadForm,
  buildProductMessage,
  buildTemplateBody,
  buildTextBody,
  buildTypingIndicatorBody,
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
// Covers Meta's per-type caps (image/sticker 5MB, audio/video 16MB); documents
// up to 100MB are not accepted through this endpoint. Keep in sync with the
// gateway's upload limit and nginx client_max_body_size.
const MEDIA_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
// fetchMediaDirect: resolve + download counts as one attempt. A second attempt
// only happens to re-resolve an expired download URL; the worker's outbox
// retry is the real backstop for anything beyond that.
const MEDIA_FETCH_MAX_ATTEMPTS = 2;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

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
  body?: Record<string, unknown> | FormData,
  accessToken?: string
): Promise<Response> {
  // For FormData, fetch must set Content-Type itself to include the boundary.
  const isForm = body instanceof FormData;
  const controller = new AbortController();
  // Media uploads move megabytes; give them longer than control-plane calls.
  const timeout = setTimeout(() => controller.abort(), isForm ? 60_000 : 10_000);
  try {
    return await fetch(`https://graph.facebook.com/${config.whatsappGraphVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken ?? config.whatsappAccessToken}`,
        ...(isForm ? {} : { "Content-Type": "application/json" })
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
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
  body?: Record<string, unknown> | FormData,
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
export interface MetaDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Transport-free core of a Graph send: performs the request and returns the
 * status + JSON body the HTTP endpoint would have written. Reused by the
 * standalone server (via dispatchSend) and by the exported direct callers that
 * app-server injects into the worker in the monolith.
 */
async function sendGraphMessage(
  requestId: string,
  phoneNumberId: string,
  body: Record<string, unknown>,
  accessToken?: string
): Promise<MetaDispatchResult> {
  try {
    const response = await graphRequest(`/${phoneNumberId}/messages`, "POST", body, accessToken);
    if (!response.ok) {
      const graphError = await parseGraphError(response);
      logger.warn("meta_send_failed", { requestId, statusCode: response.status, graphError: graphError.message });
      return { status: 502, body: { error: "meta_send_failed", details: graphError } };
    }
    const parsed = (await response.json()) as { messages?: Array<{ id: string }> };
    const result: WhatsAppSendResult = { messageId: parsed.messages?.[0]?.id, status: "accepted" };
    return { status: 202, body: { requestId, result } };
  } catch (error) {
    logger.error("meta_send_exception", { requestId, error: error instanceof Error ? error.message : String(error) });
    return { status: 503, body: { error: "meta_adapter_unavailable" } };
  }
}

async function dispatchSend(
  res: ServerResponse,
  requestId: string,
  phoneNumberId: string,
  body: Record<string, unknown>,
  accessToken?: string
): Promise<void> {
  const { status, body: payload } = await sendGraphMessage(requestId, phoneNumberId, body, accessToken);
  sendJson(res, status, payload);
}

/**
 * Direct in-process template send. Validates + builds the Graph body + sends,
 * returning the same status/body the `/internal/v1/whatsapp/send-template`
 * endpoint produces. The worker calls this in the monolith instead of HTTP.
 */
export async function sendTemplateDirect(payload: WhatsAppSendRequest, requestId: string): Promise<MetaDispatchResult> {
  if (!payload.phoneNumberId || !payload.to || !payload.templateName || !payload.templateLanguage) {
    return { status: 400, body: { error: "Missing required fields for template send" } };
  }
  const graphBody = buildTemplateBody({
    to: payload.to,
    templateName: payload.templateName,
    templateLanguage: payload.templateLanguage,
    parameters: payload.parameters ?? [],
    components: payload.components
  });
  return sendGraphMessage(requestId, payload.phoneNumberId, graphBody, payload.accessToken);
}

/**
 * Direct in-process mark-read. Mirrors the `/internal/v1/whatsapp/mark-read`
 * endpoint so the worker can mark inbound messages read without an HTTP hop.
 */
export async function markReadDirect(
  payload: WhatsAppMarkReadRequest,
  _requestId: string
): Promise<MetaDispatchResult> {
  if (!payload.phoneNumberId || !payload.messageId) {
    return { status: 400, body: { error: "phoneNumberId and messageId are required" } };
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
      return { status: 502, body: { error: "meta_mark_read_failed", details: graphError } };
    }
    return { status: 200, body: { status: "read", messageId: payload.messageId } };
  } catch (error) {
    return {
      status: 503,
      body: { error: "meta_adapter_unavailable", details: error instanceof Error ? error.message : String(error) }
    };
  }
}

/**
 * Direct in-process typing indicator. Mirrors `markReadDirect`'s shape —
 * best-effort, never routed through the outbox since a typing indicator has
 * no meaning once delayed.
 */
export async function sendTypingIndicatorDirect(
  payload: WhatsAppMarkReadRequest,
  _requestId: string
): Promise<MetaDispatchResult> {
  if (!payload.phoneNumberId || !payload.messageId) {
    return { status: 400, body: { error: "phoneNumberId and messageId are required" } };
  }
  try {
    const response = await graphRequest(
      `/${payload.phoneNumberId}/messages`,
      "POST",
      buildTypingIndicatorBody(payload.messageId),
      payload.accessToken
    );
    if (!response.ok) {
      const graphError = await parseGraphError(response);
      return { status: 502, body: { error: "meta_typing_indicator_failed", details: graphError } };
    }
    return { status: 200, body: { status: "typing_indicator_sent", messageId: payload.messageId } };
  } catch (error) {
    return {
      status: 503,
      body: { error: "meta_adapter_unavailable", details: error instanceof Error ? error.message : String(error) }
    };
  }
}

/**
 * Route an internal `/internal/v1/whatsapp/*` send/mark-read request to the
 * matching Graph builder + send, returning the same status/body the HTTP
 * endpoint produces. The worker calls this in-process in the monolith instead
 * of POSTing to the meta-adapter.
 */
export async function metaDispatch(
  endpoint: string,
  payload: Record<string, unknown>,
  requestId: string
): Promise<MetaDispatchResult> {
  const p = payload as {
    phoneNumberId?: string;
    to?: string;
    accessToken?: string;
    text?: string;
    previewUrl?: boolean;
    mediaType?: WhatsAppMediaSendRequest["mediaType"];
    link?: string;
    mediaId?: string;
    caption?: string;
    filename?: string;
    interactiveType?: WhatsAppInteractiveSendRequest["interactiveType"];
    bodyText?: string;
    headerText?: string;
    footerText?: string;
    buttons?: WhatsAppInteractiveSendRequest["buttons"];
    buttonLabel?: string;
    sections?: unknown;
    ctaDisplayText?: string;
    ctaUrl?: string;
    latitude?: number;
    longitude?: number;
    locationName?: string;
    locationAddress?: string;
    contacts?: WhatsAppContactCard[];
    catalogId?: string;
    productRetailerId?: string;
    flowId?: string;
    flowToken?: string;
    ctaButtonText?: string;
    mode?: "draft" | "published";
  };

  switch (endpoint) {
    case "/internal/v1/whatsapp/send-template":
      return sendTemplateDirect(payload as unknown as WhatsAppSendRequest, requestId);

    case "/internal/v1/whatsapp/send-text": {
      if (!p.phoneNumberId || !p.to || !p.text) {
        return { status: 400, body: { error: "phoneNumberId, to and text are required" } };
      }
      const body = buildTextBody({ to: p.to, text: p.text, previewUrl: p.previewUrl });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-media": {
      if (!p.phoneNumberId || !p.to || !p.mediaType || (!p.link && !p.mediaId)) {
        return { status: 400, body: { error: "phoneNumberId, to, mediaType and one of link/mediaId are required" } };
      }
      const body = buildMediaBody({
        to: p.to,
        mediaType: p.mediaType,
        link: p.link,
        mediaId: p.mediaId,
        caption: p.caption,
        filename: p.filename
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-location": {
      if (
        !p.phoneNumberId ||
        !p.to ||
        typeof p.latitude !== "number" ||
        typeof p.longitude !== "number" ||
        !Number.isFinite(p.latitude) ||
        !Number.isFinite(p.longitude)
      ) {
        return { status: 400, body: { error: "phoneNumberId, to, latitude and longitude are required" } };
      }
      const body = buildLocationBody({
        to: p.to,
        latitude: p.latitude,
        longitude: p.longitude,
        name: p.locationName,
        address: p.locationAddress
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-contacts": {
      if (!p.phoneNumberId || !p.to || !Array.isArray(p.contacts) || p.contacts.length === 0) {
        return { status: 400, body: { error: "phoneNumberId, to and at least one contact are required" } };
      }
      if (p.contacts.some((contact) => !contact?.name?.formattedName)) {
        return { status: 400, body: { error: "each contact requires name.formattedName" } };
      }
      const body = buildContactsBody({ to: p.to, contacts: p.contacts });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-interactive": {
      if (!p.phoneNumberId || !p.to || !p.interactiveType || !p.bodyText) {
        return { status: 400, body: { error: "phoneNumberId, to, interactiveType and bodyText are required" } };
      }
      if (p.interactiveType === "cta_url" && !p.ctaUrl) {
        return { status: 400, body: { error: "ctaUrl is required for interactiveType cta_url" } };
      }
      const body = buildInteractiveBody({
        to: p.to,
        interactiveType: p.interactiveType,
        bodyText: p.bodyText,
        headerText: p.headerText,
        footerText: p.footerText,
        buttons: p.buttons,
        buttonLabel: p.buttonLabel,
        sections: p.sections as never,
        ctaDisplayText: p.ctaDisplayText,
        ctaUrl: p.ctaUrl
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-product": {
      if (!p.phoneNumberId || !p.to || !p.catalogId || !p.productRetailerId) {
        return { status: 400, body: { error: "phoneNumberId, to, catalogId and productRetailerId are required" } };
      }
      const body = buildProductMessage({
        to: p.to,
        catalogId: p.catalogId,
        productRetailerId: p.productRetailerId,
        bodyText: p.bodyText
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-catalog": {
      if (!p.phoneNumberId || !p.to || !p.catalogId || !(p.sections as unknown[] | undefined)?.length) {
        return { status: 400, body: { error: "phoneNumberId, to, catalogId and sections are required" } };
      }
      const body = buildCatalogMessage({
        to: p.to,
        catalogId: p.catalogId,
        sections: p.sections as never,
        headerText: p.headerText,
        bodyText: p.bodyText,
        footerText: p.footerText
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/send-flow": {
      if (!p.phoneNumberId || !p.to || !p.flowId || !p.flowToken || !p.bodyText || !p.ctaButtonText) {
        return {
          status: 400,
          body: { error: "phoneNumberId, to, flowId, flowToken, bodyText and ctaButtonText are required" }
        };
      }
      const body = buildFlowMessage({
        to: p.to,
        flowId: p.flowId,
        flowToken: p.flowToken,
        bodyText: p.bodyText,
        ctaButtonText: p.ctaButtonText,
        headerText: p.headerText,
        footerText: p.footerText,
        mode: p.mode
      });
      return sendGraphMessage(requestId, p.phoneNumberId, body, p.accessToken);
    }

    case "/internal/v1/whatsapp/mark-read":
      return markReadDirect(payload as unknown as WhatsAppMarkReadRequest, requestId);

    case "/internal/v1/whatsapp/send-typing":
      return sendTypingIndicatorDirect(payload as unknown as WhatsAppMarkReadRequest, requestId);

    default:
      return { status: 404, body: { error: "unknown_meta_endpoint", endpoint } };
  }
}

export interface FetchedMedia {
  buffer: Buffer;
  mimeType?: string;
  sha256?: string;
  fileSizeBytes: number;
}

export interface MediaFetchResult {
  status: number;
  media?: FetchedMedia;
  error?: string;
}

interface ResolvedMediaUrl {
  url: string;
  mimeType?: string;
  sha256?: string;
}

type ResolveOutcome = { ok: true; data: ResolvedMediaUrl } | { ok: false; status: number; error: string };

type DownloadOutcome =
  | { ok: true; buffer: Buffer; contentType?: string }
  | { ok: false; kind: "cap"; status: 413; error: "media_too_large" }
  | { ok: false; kind: "network"; status: 503; error: "meta_adapter_unavailable" }
  | { ok: false; kind: "http"; status: number; error: "meta_media_download_failed" };

/**
 * Resolves a Graph media id to a short-lived download URL + metadata. Mirrors
 * the `/internal/v1/whatsapp/media/:id` metadata route's error mapping
 * (always 502 for a non-OK Graph response, 503 for a network/timeout
 * failure) so fetchMediaDirect and that HTTP route behave identically.
 * Never logs the token or the resolved (short-lived) URL.
 */
async function resolveMediaUrl(
  fetchImpl: typeof fetch,
  mediaId: string,
  token: string,
  requestId?: string
): Promise<ResolveOutcome> {
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${config.whatsappGraphVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      logger.warn("meta_media_resolve_failed", { requestId, mediaId, statusCode: response.status });
      return { ok: false, status: 502, error: "meta_media_failed" };
    }
    const body = (await response.json()) as { url?: string; mime_type?: string; sha256?: string };
    if (!body.url) {
      logger.warn("meta_media_resolve_missing_url", { requestId, mediaId });
      return { ok: false, status: 502, error: "meta_media_failed" };
    }
    return { ok: true, data: { url: body.url, mimeType: body.mime_type, sha256: body.sha256 } };
  } catch (error) {
    logger.error("meta_media_resolve_exception", {
      requestId,
      mediaId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, status: 503, error: "meta_adapter_unavailable" };
  }
}

/**
 * Downloads media bytes from a resolved Graph URL, enforcing
 * MEDIA_UPLOAD_MAX_BYTES against both the advertised content-length header
 * (fast rejection) and the actual downloaded buffer length (authoritative —
 * a missing/lying content-length must not bypass the cap). Never logs the
 * token or the URL (it is short-lived but still sensitive).
 */
async function downloadMediaBytes(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  requestId?: string
): Promise<DownloadOutcome> {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000)
    });

    if (!response.ok) {
      logger.warn("meta_media_download_failed", { requestId, statusCode: response.status });
      return { ok: false, kind: "http", status: response.status, error: "meta_media_download_failed" };
    }

    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    if (Number.isFinite(contentLength) && contentLength > MEDIA_UPLOAD_MAX_BYTES) {
      logger.warn("meta_media_too_large", { requestId, contentLength });
      return { ok: false, kind: "cap", status: 413, error: "media_too_large" };
    }

    // Body consumption (arrayBuffer) stays inside this try: the 60s AbortSignal
    // can fire mid-read, or the stream can error, after response.ok already
    // resolved true — those failures must map to the same network outcome as
    // a fetch()-level failure, not escape as an unhandled rejection.
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MEDIA_UPLOAD_MAX_BYTES) {
      logger.warn("meta_media_too_large", { requestId, actualBytes: buffer.length });
      return { ok: false, kind: "cap", status: 413, error: "media_too_large" };
    }

    return { ok: true, buffer, contentType: response.headers.get("content-type") ?? undefined };
  } catch (error) {
    logger.error("meta_media_download_exception", {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, kind: "network", status: 503, error: "meta_adapter_unavailable" };
  }
}

/**
 * Direct in-process media download: resolves the Graph media id to a
 * short-lived URL and downloads it, re-resolving once if the URL has
 * expired (401/403/404 on download). Never stores/reuses URLs across calls —
 * a fresh one is fetched at the start of every attempt, per Meta's ~5 minute
 * download-URL lifetime (the media id itself stays retrievable ~30 days).
 * Self-contained: uses opts.fetchImpl directly instead of the shared
 * graphRequest helper (retry/backoff/circuit-breaker) so it stays cheaply
 * testable with a fake fetch — the worker's own outbox retry is the real
 * backstop for anything beyond the 2 attempts here.
 */
export async function fetchMediaDirect(
  mediaId: string,
  accessToken?: string,
  opts?: { fetchImpl?: typeof fetch; requestId?: string }
): Promise<MediaFetchResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const requestId = opts?.requestId;
  // `||` (not `??`) is intentional: an empty-string accessToken is treated as absent so it falls through to the config default.
  const token = accessToken || config.whatsappAccessToken || undefined;

  if (!token) {
    logger.warn("meta_media_fetch_no_token", { requestId, mediaId });
    return { status: 503, error: "meta_adapter_unavailable" };
  }

  let lastFailure: { status: number; error: string } | undefined;

  for (let attempt = 1; attempt <= MEDIA_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const resolved = await resolveMediaUrl(fetchImpl, mediaId, token, requestId);
    if (!resolved.ok) {
      return { status: resolved.status, error: resolved.error };
    }

    const downloaded = await downloadMediaBytes(fetchImpl, resolved.data.url, token, requestId);
    if (downloaded.ok) {
      return {
        status: 200,
        media: {
          buffer: downloaded.buffer,
          mimeType: downloaded.contentType ?? resolved.data.mimeType,
          sha256: resolved.data.sha256,
          fileSizeBytes: downloaded.buffer.length
        }
      };
    }

    if (downloaded.kind === "cap" || downloaded.kind === "network") {
      return { status: downloaded.status, error: downloaded.error };
    }

    lastFailure = { status: 502, error: downloaded.error };
    const expiredUrl = downloaded.status === 401 || downloaded.status === 403 || downloaded.status === 404;
    if (expiredUrl && attempt < MEDIA_FETCH_MAX_ATTEMPTS) {
      logger.info("meta_media_url_expired_retry", { requestId, mediaId, attempt });
      continue;
    }
    return lastFailure;
  }

  return lastFailure ?? { status: 502, error: "meta_media_download_failed" };
}

const server = createServer(async (req, res) => {
  try {
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

    if (path.startsWith("/internal/")) {
      const providedSecret =
        typeof req.headers["x-internal-secret"] === "string" ? req.headers["x-internal-secret"] : "";
      if (config.internalServiceSecret !== "" && providedSecret !== config.internalServiceSecret) {
        logger.warn("internal_auth_failed", { requestId: ctx.requestId, path });
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (path === "/internal/v1/whatsapp/send-template") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }

      const payload = await readJsonBody<WhatsAppSendRequest>(req);
      const { status, body } = await sendTemplateDirect(payload, ctx.requestId);
      sendJson(res, status, body);
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

    if (path === "/internal/v1/whatsapp/send-product") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const payload = await readJsonBody<{
        phoneNumberId?: string;
        to?: string;
        catalogId?: string;
        productRetailerId?: string;
        bodyText?: string;
        accessToken?: string;
      }>(req);
      if (!payload.phoneNumberId || !payload.to || !payload.catalogId || !payload.productRetailerId) {
        sendJson(res, 400, { error: "phoneNumberId, to, catalogId and productRetailerId are required" });
        return;
      }
      const graphBody = buildProductMessage({
        to: payload.to,
        catalogId: payload.catalogId,
        productRetailerId: payload.productRetailerId,
        bodyText: payload.bodyText
      });
      await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
      return;
    }

    if (path === "/internal/v1/whatsapp/send-catalog") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const payload = await readJsonBody<{
        phoneNumberId?: string;
        to?: string;
        catalogId?: string;
        sections?: Array<{ title: string; productItems: Array<{ productRetailerId: string }> }>;
        headerText?: string;
        bodyText?: string;
        footerText?: string;
        accessToken?: string;
      }>(req);
      if (!payload.phoneNumberId || !payload.to || !payload.catalogId || !payload.sections?.length) {
        sendJson(res, 400, { error: "phoneNumberId, to, catalogId and sections are required" });
        return;
      }
      const graphBody = buildCatalogMessage({
        to: payload.to,
        catalogId: payload.catalogId,
        sections: payload.sections,
        headerText: payload.headerText,
        bodyText: payload.bodyText,
        footerText: payload.footerText
      });
      await dispatchSend(res, ctx.requestId, payload.phoneNumberId, graphBody, payload.accessToken);
      return;
    }

    if (path === "/internal/v1/whatsapp/send-flow") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const payload = await readJsonBody<{
        phoneNumberId?: string;
        to?: string;
        flowId?: string;
        flowToken?: string;
        bodyText?: string;
        ctaButtonText?: string;
        headerText?: string;
        footerText?: string;
        mode?: "draft" | "published";
        accessToken?: string;
      }>(req);
      if (
        !payload.phoneNumberId ||
        !payload.to ||
        !payload.flowId ||
        !payload.flowToken ||
        !payload.bodyText ||
        !payload.ctaButtonText
      ) {
        sendJson(res, 400, { error: "phoneNumberId, to, flowId, flowToken, bodyText and ctaButtonText are required" });
        return;
      }
      const graphBody = buildFlowMessage({
        to: payload.to,
        flowId: payload.flowId,
        flowToken: payload.flowToken,
        bodyText: payload.bodyText,
        ctaButtonText: payload.ctaButtonText,
        headerText: payload.headerText,
        footerText: payload.footerText,
        mode: payload.mode
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
      const { status, body } = await markReadDirect(payload, ctx.requestId);
      sendJson(res, status, body);
      return;
    }

    if (path === "/internal/v1/whatsapp/send-typing") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const payload = await readJsonBody<WhatsAppMarkReadRequest>(req);
      const { status, body } = await sendTypingIndicatorDirect(payload, ctx.requestId);
      sendJson(res, status, body);
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

        if (!response.ok) {
          const graphError = await parseGraphError(response);
          sendJson(res, 502, {
            error: "meta_phone_numbers_failed",
            details: graphError
          });
          return;
        }

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

    if (path === "/internal/v1/whatsapp/templates") {
      if (method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      const query = parseQuery(req.url);
      const wabaId = query.get("wabaId") ?? config.whatsappWabaId;
      const tokenHeader = req.headers["x-access-token"];
      const accessToken =
        (typeof tokenHeader === "string" && tokenHeader.length > 0 ? tokenHeader : undefined) ??
        config.whatsappAccessToken ??
        undefined;
      if (!wabaId) {
        sendJson(res, 400, { error: "wabaId is required" });
        return;
      }
      // No token — cannot call Meta API; return empty list so callers degrade gracefully.
      if (!accessToken) {
        sendJson(res, 200, { items: [], warning: "no_access_token" });
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
          error: "meta_templates_failed",
          details: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // Upload media bytes to Meta to obtain a reusable media id. The raw file is
    // the request body; metadata travels in query/headers so the bytes stay intact.
    if (path === "/internal/v1/whatsapp/media") {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const query = parseQuery(req.url);
      const phoneNumberId = query.get("phoneNumberId") ?? config.whatsappPhoneNumberId;
      const filename = query.get("filename") ?? undefined;
      const mimeType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      const tokenHeader = req.headers["x-access-token"];
      const accessToken = typeof tokenHeader === "string" && tokenHeader.length > 0 ? tokenHeader : undefined;
      if (!phoneNumberId) {
        sendJson(res, 400, { error: "phoneNumberId is required" });
        return;
      }
      if (!mimeType || mimeType.startsWith("application/json")) {
        sendJson(res, 400, { error: "Content-Type must be the media MIME type (e.g. image/jpeg)" });
        return;
      }
      let buffer: Buffer;
      try {
        buffer = await readBinaryBody(req, MEDIA_UPLOAD_MAX_BYTES);
      } catch {
        sendJson(res, 413, { error: "media_too_large", maxBytes: MEDIA_UPLOAD_MAX_BYTES });
        return;
      }
      if (buffer.length === 0) {
        sendJson(res, 400, { error: "Request body (file bytes) is required" });
        return;
      }
      try {
        const form = buildMediaUploadForm({ buffer, mimeType, filename });
        const response = await graphRequest(`/${phoneNumberId}/media`, "POST", form, accessToken);
        if (!response.ok) {
          const graphError = await parseGraphError(response);
          logger.warn("meta_media_upload_failed", { requestId: ctx.requestId, statusCode: response.status });
          sendJson(res, 502, { error: "meta_media_upload_failed", details: graphError });
          return;
        }
        const parsed = (await response.json()) as { id?: string };
        sendJson(res, 201, { requestId: ctx.requestId, mediaId: parsed.id });
      } catch (error) {
        sendJson(res, 503, {
          error: "meta_adapter_unavailable",
          details: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // Standalone-mode parity for fetchMediaDirect: resolves the media id to a
    // fresh Graph URL and streams the bytes back. Must be matched before the
    // metadata route below since that route matches on the same path prefix.
    if (path.startsWith("/internal/v1/whatsapp/media/") && path.endsWith("/download")) {
      if (method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      const mediaId = path.slice("/internal/v1/whatsapp/media/".length, -"/download".length).trim();
      if (!mediaId) {
        sendJson(res, 400, { error: "mediaId is required" });
        return;
      }
      const query = parseQuery(req.url);
      const accessToken = query.get("accessToken") ?? undefined;
      const result = await fetchMediaDirect(mediaId, accessToken, { requestId: ctx.requestId });
      if (!result.media) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      res.statusCode = result.status;
      res.setHeader("Content-Type", result.media.mimeType ?? "application/octet-stream");
      res.setHeader("Content-Length", result.media.fileSizeBytes);
      res.end(result.media.buffer);
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

      await sleep(100);
      sendJson(res, 200, {
        status: "ok",
        message: "Probe completed"
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

// Boot the standalone HTTP service only when executed directly, never when the
// package is imported by app-server for its exported send/mark-read functions.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(port, () => {
    logger.info("service_started", { port, nodeEnv: config.nodeEnv });
  });

  server.on("error", (error) => {
    logger.error("service_error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}
