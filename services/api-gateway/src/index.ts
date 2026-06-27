import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import { loadConfig } from "@hyfib/config";
import { createAuthenticator, hasAnyRole, AuthError, type AuthContext } from "@hyfib/auth";
import { createEventBus } from "@hyfib/event-bus";
import {
  auditRepository,
  autoReplyRuleRepository,
  campaignRecipientRepository,
  campaignRepository,
  channelRepository,
  closePool,
  consentRepository,
  contactImportRepository,
  contactRepository,
  conversationRepository,
  healthCheck,
  linkClickRepository,
  messageRepository,
  orderRepository,
  outboxRepository,
  resolveChannelByPhoneNumberId,
  segmentRepository,
  templateRepository,
  tenantAnalytics,
  tenantRepository,
  userRepository,
  withTenant,
  type CampaignWithTemplate
} from "@hyfib/persistence";
import {
  IdempotencyStore,
  Logger,
  parseQuery,
  parseUrlPath,
  readBinaryBody,
  readJsonBody,
  readRawBody,
  requestContext,
  sendJson,
  sendMetrics,
  incCounter,
  verifyMetaSignature,
  EventTopics,
  type EventEnvelope,
  type FrequencyCapConfig,
  type MessageCategory,
  type QuietHoursConfig,
  type Role,
  type Segment,
  type Template,
  type VariableMapping,
  type WhatsAppInteractivePayload,
  type WhatsAppMediaKind
} from "@hyfib/shared-core";
import { validateInteractivePayload } from "./validation.js";
import { canCreateContact, canCreateOrder } from "./authorization.js";
import { SseHub } from "./sse-hub.js";
import { parseCsv } from "./csv.js";

// ─── Request body interfaces ───────────────────────────────────────────────────

interface CreateTenantRequest {
  name: string;
}

interface CreateUserRequest {
  email: string;
  displayName: string;
  roles: Role[];
}

interface CreateChannelRequest {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  accessToken?: string;
}

interface SendMessageRequest {
  kind?: "text" | "media" | "interactive" | "product" | "catalog" | "flow";
  text?: string;
  previewUrl?: boolean;
  media?: { mediaType: WhatsAppMediaKind; link?: string; mediaId?: string; caption?: string; filename?: string };
  interactive?: WhatsAppInteractivePayload;
  product?: { catalogId: string; productRetailerId: string; bodyText?: string };
  catalog?: {
    catalogId: string;
    sections: Array<{ title: string; productItems: Array<{ productRetailerId: string }> }>;
    headerText?: string;
    bodyText?: string;
    footerText?: string;
  };
  flow?: {
    flowId: string;
    flowToken: string;
    bodyText: string;
    ctaButtonText: string;
    headerText?: string;
    footerText?: string;
  };
}

interface CreateTemplateRequest {
  name: string;
  category: "marketing" | "utility" | "authentication" | "service";
  language: string;
  body: string;
}

interface CreateCampaignRequest {
  name: string;
  templateId: string;
  segmentId?: string;
  scheduledAt?: string;
  variableMapping?: VariableMapping;
  ratePerMinute?: number;
  quietHours?: QuietHoursConfig;
  frequencyCap?: FrequencyCapConfig;
}

/**
 * Single-number test-send (replaces the old trusted-inputs dispatch).
 * Policy is computed entirely from DB state; no caller-supplied hints.
 */
interface DispatchCampaignRequest {
  contactPhoneE164: string;
  parameters?: string[];
}

interface CreateContactRequest {
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  tags?: string[];
  timezone?: string;
}

interface CreateOrderRequest {
  contactId: string;
  externalOrderId: string;
  amountMinor: number;
  currency: string;
}

interface CreateSegmentRequest {
  name: string;
  definition: Segment["definition"];
}

interface CreateAutoReplyRuleRequest {
  matchType?: "keyword" | "contains" | "regex" | "any";
  keyword?: string;
  replyKind?: "text";
  replyText?: string;
  enabled?: boolean;
  priority?: number;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
const logger = new Logger("api-gateway", config.logLevel as "debug" | "info" | "warn" | "error");
const authenticator = createAuthenticator(config);
const eventBus = createEventBus(config);
const webhookIdempotency = new IdempotencyStore(24 * 60 * 60 * 1000);

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const CSV_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

if (!config.authEnabled) {
  logger.warn("auth_disabled_dev_mode", {
    message: "AUTH_ENABLED=false — caller identity is taken from headers. Never use this in production."
  });
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Cache-Control", "no-store");
}

async function resolveAuth(req: IncomingMessage): Promise<AuthContext> {
  if (config.authEnabled) {
    return authenticator.authenticate(req.headers["authorization"]);
  }
  const roleHeader = req.headers["x-role"];
  const roles = (typeof roleHeader === "string" ? roleHeader.split(",") : [])
    .map((value) => value.trim())
    .filter((value): value is Role => value.length > 0) as Role[];
  const tenantId = typeof req.headers["x-tenant-id"] === "string" ? (req.headers["x-tenant-id"] as string) : undefined;
  const actorId = typeof req.headers["x-actor-id"] === "string" ? (req.headers["x-actor-id"] as string) : undefined;
  return { subject: actorId ?? "dev-subject", tenantId, roles };
}

function asActorUuid(subject: string): string | undefined {
  return UUID.test(subject) ? subject : undefined;
}

async function audit(
  tenantId: string,
  ctx: AuthContext,
  event: { action: string; resourceType: string; resourceId?: string; payload: Record<string, unknown> }
): Promise<void> {
  try {
    await auditRepository.add(tenantId, { actorId: asActorUuid(ctx.subject), ...event });
  } catch (error) {
    logger.error("audit_write_failed", {
      action: event.action,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ─── Campaign: single-number test-send (Phase 0: all inputs from DB) ──────────

async function dispatchCampaign(
  tenantId: string,
  campaign: CampaignWithTemplate,
  template: Template,
  payload: DispatchCampaignRequest
): Promise<{ status: number; body: Record<string, unknown> }> {
  const knownContact = await contactRepository.findByPhone(tenantId, payload.contactPhoneE164);
  if (!knownContact) {
    return {
      status: 422,
      body: { error: "campaign_blocked_by_policy", reason: "Unknown contact (not in contacts list)" }
    };
  }

  const isOptedOut = knownContact.optedOut;
  const hasActiveConsent = await consentRepository.hasActiveConsent(tenantId, knownContact.id);

  // Determine 24h window from last inbound message timestamp.
  const lastInboundAt = await conversationRepository.lastInboundAt(tenantId, knownContact.id);
  const isInside24hWindow = lastInboundAt ? Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000 : false;

  // Compute current local hour from contact timezone (fallback UTC).
  const tz = knownContact.timezone ?? "UTC";
  const currentHourLocal = getCurrentHourInTz(tz);

  // Read quiet hours and frequency cap from the campaign record (DB source of truth).
  const quietHours = campaign.quietHours;
  const frequencyCapConfig = campaign.frequencyCap;

  let sentInPeriod = 0;
  if (frequencyCapConfig) {
    const since = new Date(Date.now() - frequencyCapConfig.periodHours * 60 * 60 * 1000).toISOString();
    sentInPeriod = await messageRepository.countOutboundSince(tenantId, knownContact.id, since);
  }

  const policy = evaluateOutboundPolicy({
    hasActiveConsent,
    isInside24hWindow,
    template,
    requestedCategory: campaign.templateCategory,
    isOptedOut,
    currentHourLocal,
    quietHours,
    frequencyCap: frequencyCapConfig ? { ...frequencyCapConfig, sentInPeriod } : undefined
  });

  if (!policy.allowed) {
    return { status: 422, body: { error: "campaign_blocked_by_policy", reason: policy.reason } };
  }

  const channel = await channelRepository.firstActive(tenantId);
  if (!channel) {
    return { status: 409, body: { error: "No active WhatsApp channel configured for tenant" } };
  }

  await withTenant(tenantId, async (client) => {
    await client.query("UPDATE campaigns SET status = 'running' WHERE id = $1", [campaign.id]);
    await outboxRepository.enqueue(client, tenantId, {
      topic: EventTopics.CampaignDispatchRequested,
      payload: {
        campaignId: campaign.id,
        tenantId,
        channelId: channel.id,
        templateName: campaign.templateName,
        templateLanguage: campaign.templateLanguage,
        templateCategory: campaign.templateCategory,
        contactPhoneE164: payload.contactPhoneE164,
        parameters: payload.parameters ?? []
      }
    });
  });

  return { status: 202, body: { status: "dispatch_enqueued", campaignId: campaign.id } };
}

/**
 * Triggers a full audience fan-out.
 * 1. Materialises recipients from segment (or existing campaign_recipients).
 * 2. Inserts pending recipient rows.
 * 3. Enqueues CampaignRunRequested for the worker to process asynchronously.
 */
async function runCampaign(
  tenantId: string,
  campaign: CampaignWithTemplate,
  template: Template
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!["draft", "paused"].includes(campaign.status)) {
    return { status: 409, body: { error: `Campaign is already ${campaign.status}` } };
  }
  if (template.status !== "approved") {
    return { status: 422, body: { error: "Template must be approved before running a campaign" } };
  }
  if (!campaign.segmentId) {
    return { status: 422, body: { error: "Campaign has no segment. Set a segment_id before running." } };
  }

  const segment = await segmentRepository.getById(tenantId, campaign.segmentId);
  if (!segment) {
    return { status: 422, body: { error: "Segment not found" } };
  }

  const contacts = await segmentRepository.resolveContacts(tenantId, segment.definition);
  if (contacts.length === 0) {
    return { status: 422, body: { error: "Segment resolved to 0 contacts" } };
  }

  const channel = await channelRepository.firstActive(tenantId);
  if (!channel) {
    return { status: 409, body: { error: "No active WhatsApp channel configured for tenant" } };
  }

  await campaignRecipientRepository.insertBatch(
    tenantId,
    campaign.id,
    contacts.map((c) => ({ id: c.id, phoneE164: c.phoneE164 }))
  );

  await withTenant(tenantId, async (client) => {
    await client.query("UPDATE campaigns SET status = 'running' WHERE id = $1", [campaign.id]);
    await outboxRepository.enqueue(client, tenantId, {
      topic: EventTopics.CampaignRunRequested,
      payload: {
        campaignId: campaign.id,
        tenantId,
        channelId: channel.id,
        templateName: campaign.templateName,
        templateLanguage: campaign.templateLanguage,
        templateCategory: campaign.templateCategory,
        templateStatus: campaign.templateStatus ?? "approved",
        variableMapping: campaign.variableMapping,
        quietHours: campaign.quietHours,
        frequencyCap: campaign.frequencyCap,
        ratePerMinute: campaign.ratePerMinute
      }
    });
  });

  return { status: 202, body: { status: "run_started", campaignId: campaign.id, recipientCount: contacts.length } };
}

function getCurrentHourInTz(tz: string): number {
  try {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now);
    const h = parseInt(formatted, 10);
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return new Date().getUTCHours();
  }
}

// ─── Template sync ─────────────────────────────────────────────────────────────

const META_CATEGORIES: ReadonlySet<MessageCategory> = new Set(["marketing", "utility", "authentication", "service"]);

interface MetaTemplateItem {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
}

async function syncTemplates(
  tenantId: string,
  channelId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const channel = await channelRepository.getCredentials(tenantId, channelId);
  if (!channel) {
    return { status: 404, body: { error: "Channel not found" } };
  }
  const url = new URL(`${config.metaAdapterUrl}/internal/v1/whatsapp/templates`);
  url.searchParams.set("wabaId", channel.wabaId);
  if (channel.accessToken) {
    url.searchParams.set("accessToken", channel.accessToken);
  }
  let items: MetaTemplateItem[];
  try {
    const response = await fetch(url, { headers: { "x-tenant-id": tenantId, "x-request-id": randomUUID() } });
    const body = (await response.json()) as { items?: MetaTemplateItem[]; error?: string; warning?: string };
    if (!response.ok) {
      return { status: 502, body: { error: "template_sync_failed", detail: body.error ?? "meta error" } };
    }
    if (body.warning === "no_access_token") {
      return {
        status: 200,
        body: {
          synced: 0,
          warning:
            "No WhatsApp access token configured — add a permanent token in Settings to sync templates from Meta."
        }
      };
    }
    items = body.items ?? [];
  } catch (error) {
    return {
      status: 503,
      body: { error: "meta_adapter_unavailable", detail: error instanceof Error ? error.message : "failed" }
    };
  }

  let synced = 0;
  for (const item of items) {
    const category = (
      item.category && META_CATEGORIES.has(item.category as MessageCategory) ? item.category : "utility"
    ) as MessageCategory;
    const status = (
      ["approved", "rejected", "pending", "paused"].includes(item.status) ? item.status : "pending"
    ) as Template["status"];
    const template = await templateRepository.upsertFromMeta(tenantId, {
      name: item.name,
      language: item.language,
      status,
      category,
      body: item.body ?? ""
    });
    await eventBus.publish(
      EventTopics.TemplateStatusUpdated,
      { tenantId, templateId: template.id, name: template.name, language: template.language, status: template.status },
      tenantId
    );
    synced += 1;
  }
  return { status: 200, body: { status: "synced", synced, items } };
}

// ─── Conversation session message ──────────────────────────────────────────────

async function sendConversationMessage(
  tenantId: string,
  conversationId: string,
  auth: AuthContext,
  body: SendMessageRequest
): Promise<{ status: number; body: Record<string, unknown> }> {
  const conversation = await conversationRepository.getById(tenantId, conversationId);
  if (!conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }
  const contact = await contactRepository.getById(tenantId, conversation.contactId);
  if (!contact) {
    return { status: 409, body: { error: "Conversation has no contact" } };
  }
  if (contact.optedOut) {
    return { status: 422, body: { error: "contact_opted_out" } };
  }

  const kind = body.kind ?? "text";

  if (kind === "text" && !body.text?.trim()) {
    return { status: 400, body: { error: "text is required" } };
  }
  if (kind === "media" && !body.media?.mediaType) {
    return { status: 400, body: { error: "media.mediaType is required" } };
  }
  if (kind === "product" && !body.product?.catalogId) {
    return { status: 400, body: { error: "product.catalogId is required" } };
  }
  if (kind === "catalog" && !body.catalog?.catalogId) {
    return { status: 400, body: { error: "catalog.catalogId is required" } };
  }
  if (kind === "flow" && (!body.flow?.flowId || !body.flow?.bodyText)) {
    return { status: 400, body: { error: "flow.flowId and flow.bodyText are required" } };
  }

  let interactive: WhatsAppInteractivePayload | undefined;
  if (kind === "interactive") {
    const validated = validateInteractivePayload(body.interactive);
    if (!validated.ok) {
      return { status: 400, body: { error: validated.error } };
    }
    interactive = validated.value;
  }

  await withTenant(tenantId, async (client) => {
    await outboxRepository.enqueue(client, tenantId, {
      topic: EventTopics.WhatsAppOutboundRequested,
      payload: {
        tenantId,
        channelId: conversation.channelId,
        conversationId,
        contactPhoneE164: contact.phoneE164,
        kind,
        text: body.text,
        previewUrl: body.previewUrl,
        media: body.media,
        interactive,
        product: body.product,
        catalog: body.catalog,
        flow: body.flow,
        actorId: asActorUuid(auth.subject)
      }
    });
  });
  return { status: 202, body: { status: "message_enqueued", kind } };
}

// ─── Outbox relay ──────────────────────────────────────────────────────────────

function startOutboxRelay(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const batch = await outboxRepository.claim(50);
        for (const row of batch) {
          await eventBus.publish(
            row.topic as (typeof EventTopics)[keyof typeof EventTopics],
            row.payload,
            row.tenant_id ?? undefined
          );
          await outboxRepository.markProcessed(row.id);
          incCounter("events_published_total", "Events published to the bus.", { topic: row.topic });
        }
      } catch (error) {
        logger.error("outbox_relay_error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
    })();
  }, 1_000);
}

// ─── Campaign scheduler ────────────────────────────────────────────────────────

function startCampaignScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const { query: dbQuery } = await import("@hyfib/persistence");
        const result = await dbQuery<{
          id: string;
          tenant_id: string;
          template_name: string;
          template_language: string;
          template_category: string;
          template_status: string | null;
          variable_mapping: Record<string, unknown> | null;
          quiet_hours: Record<string, unknown> | null;
          frequency_cap: Record<string, unknown> | null;
          rate_per_minute: number | null;
          segment_id: string | null;
        }>(
          `SELECT c.id, c.tenant_id, c.variable_mapping, c.quiet_hours, c.frequency_cap,
                  c.rate_per_minute, c.segment_id,
                  t.name AS template_name, t.language AS template_language, t.category AS template_category, t.status AS template_status
           FROM campaigns c
           JOIN templates t ON t.id = c.template_id
           WHERE c.status = 'scheduled' AND c.scheduled_at <= now()
           LIMIT 20`
        );
        for (const row of result.rows) {
          await withTenant(row.tenant_id, async (client) => {
            if (row.segment_id) {
              const seg = await segmentRepository.getById(row.tenant_id, row.segment_id);
              if (seg) {
                const contacts = await segmentRepository.resolveContacts(row.tenant_id, seg.definition);
                await campaignRecipientRepository.insertBatch(
                  row.tenant_id,
                  row.id,
                  contacts.map((c) => ({ id: c.id, phoneE164: c.phoneE164 }))
                );
              }
            }
            const channel = await channelRepository.firstActive(row.tenant_id);
            if (!channel) return;
            await client.query("UPDATE campaigns SET status = 'running', scheduled_at = NULL WHERE id = $1", [row.id]);
            await outboxRepository.enqueue(client, row.tenant_id, {
              topic: EventTopics.CampaignRunRequested,
              payload: {
                campaignId: row.id,
                tenantId: row.tenant_id,
                channelId: channel.id,
                templateName: row.template_name,
                templateLanguage: row.template_language,
                templateCategory: row.template_category,
                templateStatus: row.template_status ?? "approved",
                variableMapping: row.variable_mapping,
                quietHours: row.quiet_hours,
                frequencyCap: row.frequency_cap,
                ratePerMinute: row.rate_per_minute
              }
            });
          });
        }
      } catch (error) {
        logger.error("scheduler_error", { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, 30_000);
}

// ─── SSE hub ──────────────────────────────────────────────────────────────────

const sseHub = new SseHub();
const sseTenantByPhoneNumberId = new Map<string, string>();

async function forwardEventToSse(event: EventEnvelope): Promise<void> {
  if (!sseHub.hasClients()) return;
  const payload = event.payload as { phoneNumberId?: string } | undefined;
  const phoneNumberId = typeof payload?.phoneNumberId === "string" ? payload.phoneNumberId : undefined;
  if (!phoneNumberId) return;
  try {
    let resolvedTenantId = sseTenantByPhoneNumberId.get(phoneNumberId);
    if (!resolvedTenantId) {
      const channel = await resolveChannelByPhoneNumberId(phoneNumberId);
      if (!channel) return;
      resolvedTenantId = channel.tenantId;
      if (sseTenantByPhoneNumberId.size >= 1_000) sseTenantByPhoneNumberId.clear();
      sseTenantByPhoneNumberId.set(phoneNumberId, resolvedTenantId);
    }
    sseHub.broadcast(resolvedTenantId, event.topic, event.id, {
      occurredAt: event.occurredAt,
      payload: event.payload
    });
  } catch (error) {
    logger.warn("sse_forward_failed", {
      topic: event.topic,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const sseQueuePrefix = `api-gateway-sse.${randomUUID().slice(0, 8)}`;
eventBus.subscribe(EventTopics.WhatsAppInboundReceived, `${sseQueuePrefix}.inbound`, forwardEventToSse, {
  ephemeral: true
});
eventBus.subscribe(EventTopics.WhatsAppStatusUpdated, `${sseQueuePrefix}.status`, forwardEventToSse, {
  ephemeral: true
});
sseHub.startKeepAlive();

// ─── Request handler ───────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = parseUrlPath(req.url);
  const ctx = requestContext(req);
  incCounter("http_requests_total", "Total HTTP requests received.", { service: "api-gateway" });

  if (path === "/metrics") {
    sendMetrics(res);
    return;
  }

  if (path === "/health") {
    let db = false;
    try {
      db = await healthCheck();
    } catch {
      db = false;
    }
    sendJson(res, db ? 200 : 503, {
      service: "api-gateway",
      status: db ? "ok" : "degraded",
      database: db,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // ─── Link click redirect (public, no auth) ───────────────────────────────
  if (path.startsWith("/r/") && method === "GET") {
    const token = path.slice(3);
    if (token) {
      const click = await linkClickRepository.recordClick(token).catch(() => undefined);
      if (click) {
        res.writeHead(302, { Location: click.destination });
        res.end();
        return;
      }
    }
    sendJson(res, 404, { error: "link_not_found" });
    return;
  }

  // ─── Webhook verification handshake ──────────────────────────────────────
  if (path === "/api/v1/webhooks/meta/whatsapp" && method === "GET") {
    const query = parseQuery(req.url);
    if (
      query.get("hub.mode") === "subscribe" &&
      query.get("hub.verify_token") === config.webhookVerifyToken &&
      query.get("hub.challenge")
    ) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(query.get("hub.challenge")!);
      return;
    }
    sendJson(res, 403, { error: "Webhook verification failed" });
    return;
  }

  // ─── Inbound webhook (HMAC-authenticated, no JWT) ────────────────────────
  if (path === "/api/v1/webhooks/meta/whatsapp" && method === "POST") {
    const signature = req.headers["x-hub-signature-256"];
    const normalizedSignature = typeof signature === "string" ? signature : undefined;
    if (!normalizedSignature) {
      sendJson(res, 401, { error: "Missing x-hub-signature-256 header" });
      return;
    }
    const rawBody = await readRawBody(req);
    if (!verifyMetaSignature(rawBody, normalizedSignature, config.metaAppSecret)) {
      sendJson(res, 401, { error: "Invalid webhook signature" });
      return;
    }
    if (webhookIdempotency.isDuplicate(`webhook:${normalizedSignature}`)) {
      sendJson(res, 200, { status: "duplicate_ignored" });
      return;
    }
    const proxyResponse = await fetch(`${config.webhookIngestorUrl}/internal/v1/webhooks/meta/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": randomUUID() },
      body: JSON.stringify({ rawBody, signature: normalizedSignature })
    });
    const proxyBody = (await proxyResponse.json()) as Record<string, unknown>;
    sendJson(res, proxyResponse.ok ? 200 : 502, { requestId: ctx.requestId, upstream: proxyBody });
    return;
  }

  if (!path.startsWith("/api/v1/")) {
    sendJson(res, 404, { error: "route_not_found", method, path, requestId: ctx.requestId });
    return;
  }

  // ─── JWT / header auth ────────────────────────────────────────────────────
  let auth: AuthContext;
  try {
    auth = await resolveAuth(req);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    sendJson(res, status, { error: "unauthenticated", detail: error instanceof Error ? error.message : "auth failed" });
    return;
  }

  if (auth.roles.length === 0) {
    sendJson(res, 403, { error: "no_roles_assigned" });
    return;
  }

  // ─── Tenants ──────────────────────────────────────────────────────────────
  if (path === "/api/v1/tenants") {
    if (method === "GET") {
      if (!hasAnyRole(auth, ["platform_owner"])) {
        sendJson(res, 403, { error: "Only platform_owner can list tenants" });
        return;
      }
      sendJson(res, 200, { items: await tenantRepository.list() });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner"])) {
        sendJson(res, 403, { error: "Only platform_owner can create tenants" });
        return;
      }
      const payload = await readJsonBody<CreateTenantRequest>(req);
      if (!payload.name?.trim()) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const tenant = await tenantRepository.create(payload.name.trim());
      await audit(tenant.id, auth, {
        action: "tenant.created",
        resourceType: "Tenant",
        resourceId: tenant.id,
        payload: { name: tenant.name }
      });
      sendJson(res, 201, { ...tenant });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Tenant-scoped routes ─────────────────────────────────────────────────
  const tenantId = auth.tenantId;
  if (!tenantId) {
    sendJson(res, 403, { error: "Token is missing tenant_id claim" });
    return;
  }

  // ─── SSE stream ───────────────────────────────────────────────────────────
  if (path === "/api/v1/events/stream") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");
    const clientId = sseHub.addClient(tenantId, res);
    incCounter("sse_clients_connected_total", "SSE clients connected.", { service: "api-gateway" });
    req.on("close", () => sseHub.removeClient(tenantId, clientId));
    return;
  }

  // ─── Users ────────────────────────────────────────────────────────────────
  if (path === "/api/v1/users") {
    if (method === "GET") {
      sendJson(res, 200, { items: await userRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
        sendJson(res, 403, { error: "Only platform_owner/tenant_admin can create users" });
        return;
      }
      const payload = await readJsonBody<CreateUserRequest>(req);
      if (!payload.email?.trim() || !payload.displayName?.trim() || !payload.roles?.length) {
        sendJson(res, 400, { error: "email, displayName, and roles are required" });
        return;
      }
      const user = await userRepository.create(tenantId, {
        email: payload.email.trim(),
        displayName: payload.displayName.trim(),
        roles: payload.roles
      });
      await audit(tenantId, auth, {
        action: "user.created",
        resourceType: "User",
        resourceId: user.id,
        payload: { email: user.email, roles: user.roles }
      });
      sendJson(res, 201, { ...user });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Channels ─────────────────────────────────────────────────────────────
  if (path === "/api/v1/channels/whatsapp") {
    if (method === "GET") {
      sendJson(res, 200, { items: await channelRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
        sendJson(res, 403, { error: "Only platform_owner/tenant_admin can register channels" });
        return;
      }
      const payload = await readJsonBody<CreateChannelRequest>(req);
      if (!payload.wabaId || !payload.phoneNumberId || !payload.displayPhoneNumber) {
        sendJson(res, 400, { error: "wabaId, phoneNumberId, displayPhoneNumber are required" });
        return;
      }
      let channel;
      try {
        channel = await channelRepository.create(tenantId, {
          wabaId: payload.wabaId,
          phoneNumberId: payload.phoneNumberId,
          displayPhoneNumber: payload.displayPhoneNumber,
          accessToken: payload.accessToken
        });
      } catch (error) {
        sendJson(res, 400, {
          error: "channel_create_failed",
          detail: error instanceof Error ? error.message : "failed"
        });
        return;
      }
      await audit(tenantId, auth, {
        action: "channel.whatsapp.created",
        resourceType: "WhatsAppChannel",
        resourceId: channel.id,
        payload: { phoneNumberId: channel.phoneNumberId, hasToken: Boolean(payload.accessToken) }
      });
      sendJson(res, 201, { ...channel });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/channels/whatsapp/") && path.endsWith("/sync-templates") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role to sync templates" });
      return;
    }
    const channelId = path.replace("/api/v1/channels/whatsapp/", "").replace("/sync-templates", "").trim();
    if (!UUID.test(channelId)) {
      sendJson(res, 400, { error: "Invalid channel id" });
      return;
    }
    const result = await syncTemplates(tenantId, channelId);
    if (result.status === 200) {
      await audit(tenantId, auth, {
        action: "template.synced",
        resourceType: "WhatsAppChannel",
        resourceId: channelId,
        payload: { synced: (result.body.synced as number) ?? 0 }
      });
    }
    sendJson(res, result.status, result.body);
    return;
  }

  if (path.startsWith("/api/v1/channels/whatsapp/") && path.endsWith("/media") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
      sendJson(res, 403, { error: "Insufficient role to upload media" });
      return;
    }
    const channelId = path.replace("/api/v1/channels/whatsapp/", "").replace("/media", "").trim();
    if (!UUID.test(channelId)) {
      sendJson(res, 400, { error: "Invalid channel id" });
      return;
    }
    const channel = await channelRepository.getCredentials(tenantId, channelId);
    if (!channel) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }
    const mimeType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
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
    const uploadUrl = new URL(`${config.metaAdapterUrl}/internal/v1/whatsapp/media`);
    uploadUrl.searchParams.set("phoneNumberId", channel.phoneNumberId);
    const filename = parseQuery(req.url).get("filename");
    if (filename) uploadUrl.searchParams.set("filename", filename);
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": mimeType,
          "x-tenant-id": tenantId,
          "x-request-id": randomUUID(),
          ...(channel.accessToken ? { "x-access-token": channel.accessToken } : {})
        },
        body: new Uint8Array(buffer)
      });
      const body = (await response.json()) as { mediaId?: string; error?: string };
      if (!response.ok || !body.mediaId) {
        sendJson(res, 502, { error: "media_upload_failed", detail: body.error ?? "meta error" });
        return;
      }
      await audit(tenantId, auth, {
        action: "channel.media.uploaded",
        resourceType: "WhatsAppChannel",
        resourceId: channelId,
        payload: { mimeType, bytes: buffer.length, mediaId: body.mediaId }
      });
      sendJson(res, 201, { mediaId: body.mediaId });
    } catch (error) {
      sendJson(res, 503, {
        error: "meta_adapter_unavailable",
        detail: error instanceof Error ? error.message : "failed"
      });
    }
    return;
  }

  // ─── Templates ────────────────────────────────────────────────────────────
  if (path === "/api/v1/templates") {
    if (method === "GET") {
      sendJson(res, 200, { items: await templateRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role to create templates" });
        return;
      }
      const payload = await readJsonBody<CreateTemplateRequest>(req);
      if (!payload.name || !payload.category || !payload.language || !payload.body) {
        sendJson(res, 400, { error: "name, category, language, body are required" });
        return;
      }
      const template = await templateRepository.create(tenantId, {
        name: payload.name,
        category: payload.category,
        language: payload.language,
        body: payload.body,
        status: "pending"
      });
      await audit(tenantId, auth, {
        action: "template.created",
        resourceType: "Template",
        resourceId: template.id,
        payload: { name: template.name, category: template.category }
      });
      sendJson(res, 201, { ...template });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Segments ─────────────────────────────────────────────────────────────
  if (path === "/api/v1/segments") {
    if (method === "GET") {
      sendJson(res, 200, { items: await segmentRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role to create segments" });
        return;
      }
      const payload = await readJsonBody<CreateSegmentRequest>(req);
      if (!payload.name?.trim()) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const segment = await segmentRepository.create(tenantId, {
        name: payload.name.trim(),
        definition: payload.definition ?? {}
      });
      await audit(tenantId, auth, {
        action: "segment.created",
        resourceType: "Segment",
        resourceId: segment.id,
        payload: { name: segment.name }
      });
      sendJson(res, 201, { ...segment });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/segments/") && path.endsWith("/preview") && method === "GET") {
    const segmentId = path.replace("/api/v1/segments/", "").replace("/preview", "").trim();
    if (!UUID.test(segmentId)) {
      sendJson(res, 400, { error: "Invalid segment id" });
      return;
    }
    const segment = await segmentRepository.getById(tenantId, segmentId);
    if (!segment) {
      sendJson(res, 404, { error: "Segment not found" });
      return;
    }
    const contacts = await segmentRepository.resolveContacts(tenantId, segment.definition);
    sendJson(res, 200, { count: contacts.length, sample: contacts.slice(0, 5) });
    return;
  }

  // ─── Contacts ─────────────────────────────────────────────────────────────
  if (path === "/api/v1/contacts") {
    if (method === "GET") {
      sendJson(res, 200, { items: await contactRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!canCreateContact(auth)) {
        sendJson(res, 403, { error: "Insufficient role to create contacts" });
        return;
      }
      const payload = await readJsonBody<CreateContactRequest>(req);
      if (!E164.test(payload.phoneE164 ?? "")) {
        sendJson(res, 400, { error: "phoneE164 must be E.164 formatted" });
        return;
      }
      const contact = await contactRepository.create(tenantId, payload);
      await audit(tenantId, auth, {
        action: "contact.created",
        resourceType: "Contact",
        resourceId: contact.id,
        payload: { phoneE164: contact.phoneE164 }
      });
      sendJson(res, 201, { ...contact });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Contact CSV import ───────────────────────────────────────────────────
  if (path === "/api/v1/contacts/import" && method === "POST") {
    if (!canCreateContact(auth)) {
      sendJson(res, 403, { error: "Insufficient role to import contacts" });
      return;
    }
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
    let csvBuffer: Buffer;
    try {
      csvBuffer = await readBinaryBody(req, CSV_UPLOAD_MAX_BYTES);
    } catch {
      sendJson(res, 413, { error: "csv_too_large", maxBytes: CSV_UPLOAD_MAX_BYTES });
      return;
    }
    if (csvBuffer.length === 0) {
      sendJson(res, 400, { error: "Empty body" });
      return;
    }
    const { rows: csvRows, errors } = parseCsv(csvBuffer);
    if (csvRows.length === 0) {
      sendJson(res, 422, { error: "No valid rows in CSV", parseErrors: errors });
      return;
    }
    const importRows = csvRows.map((r) => ({
      phoneE164: r.phoneE164!,
      firstName: r.firstName,
      lastName: r.lastName,
      country: r.country,
      timezone: r.timezone,
      tags: r.tags,
      grantConsent: r.consent === true
    }));
    const { created, updated, skipped } = await contactRepository.bulkUpsert(tenantId, importRows);
    const filename = contentType.includes("filename=")
      ? contentType.split("filename=")[1]?.split(";")[0]?.trim()
      : undefined;
    await contactImportRepository.create(tenantId, {
      filename,
      total: csvRows.length + errors.length,
      created,
      updated,
      skipped: skipped + errors.length
    });
    await audit(tenantId, auth, {
      action: "contacts.imported",
      resourceType: "Contact",
      payload: { created, updated, skipped }
    });
    sendJson(res, 200, { status: "imported", created, updated, skipped: skipped + errors.length, parseErrors: errors });
    return;
  }

  if (path.startsWith("/api/v1/contacts/") && path.endsWith("/consent") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role to record consent" });
      return;
    }
    const contactId = path.replace("/api/v1/contacts/", "").replace("/consent", "").trim();
    if (!UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const contact = await contactRepository.getById(tenantId, contactId);
    if (!contact) {
      sendJson(res, 404, { error: "Contact not found" });
      return;
    }
    const body = await readJsonBody<{ source?: string; policyVersion?: string }>(req);
    await consentRepository.grant(tenantId, contactId, {
      source: body.source ?? "manual",
      policyVersion: body.policyVersion ?? "v1"
    });
    await contactRepository.setOptedOut(tenantId, contactId, false);
    await audit(tenantId, auth, {
      action: "consent.granted",
      resourceType: "Contact",
      resourceId: contactId,
      payload: { source: body.source ?? "manual" }
    });
    sendJson(res, 201, { status: "consent_recorded", contactId });
    return;
  }

  if (path.startsWith("/api/v1/contacts/") && path.endsWith("/opt-out") && method === "POST") {
    if (
      !hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "support_agent", "compliance_auditor"])
    ) {
      sendJson(res, 403, { error: "Insufficient role to opt out a contact" });
      return;
    }
    const contactId = path.replace("/api/v1/contacts/", "").replace("/opt-out", "").trim();
    if (!UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const contact = await contactRepository.getById(tenantId, contactId);
    if (!contact) {
      sendJson(res, 404, { error: "Contact not found" });
      return;
    }
    const body = await readJsonBody<{ reason?: string }>(req);
    const reason = body.reason ?? "manual_opt_out";
    await consentRepository.revoke(tenantId, contactId, reason);
    await contactRepository.setOptedOut(tenantId, contactId, true);
    await withTenant(tenantId, async (client) => {
      await outboxRepository.enqueue(client, tenantId, {
        topic: EventTopics.ComplianceOptOutEvent,
        payload: { tenantId, contactId, phoneE164: contact.phoneE164, reason }
      });
    });
    await audit(tenantId, auth, {
      action: "contact.opted_out",
      resourceType: "Contact",
      resourceId: contactId,
      payload: { reason }
    });
    sendJson(res, 200, { status: "opted_out", contactId });
    return;
  }

  // ─── Campaigns ────────────────────────────────────────────────────────────
  if (path === "/api/v1/campaigns") {
    if (method === "GET") {
      sendJson(res, 200, { items: await campaignRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role to create campaigns" });
        return;
      }
      const payload = await readJsonBody<CreateCampaignRequest>(req);
      if (!payload.name?.trim() || !payload.templateId) {
        sendJson(res, 400, { error: "name and templateId are required" });
        return;
      }
      const template = await templateRepository.getById(tenantId, payload.templateId);
      if (!template) {
        sendJson(res, 422, { error: "templateId does not reference a known template" });
        return;
      }
      if (template.category !== "marketing") {
        sendJson(res, 422, { error: "Only marketing templates are allowed for campaigns" });
        return;
      }
      const campaign = await campaignRepository.create(tenantId, {
        name: payload.name.trim(),
        templateId: payload.templateId,
        segmentId: payload.segmentId,
        scheduledAt: payload.scheduledAt,
        variableMapping: payload.variableMapping,
        ratePerMinute: payload.ratePerMinute,
        quietHours: payload.quietHours,
        frequencyCap: payload.frequencyCap
      });
      await audit(tenantId, auth, {
        action: "campaign.created",
        resourceType: "Campaign",
        resourceId: campaign.id,
        payload: { name: campaign.name, templateId: campaign.templateId }
      });
      sendJson(res, 201, { ...campaign });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Campaign: single-number test-send (Phase 0 — now server-side policy).
  if (path.startsWith("/api/v1/campaigns/") && path.endsWith("/dispatch") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role to dispatch campaigns" });
      return;
    }
    const campaignId = path.replace("/api/v1/campaigns/", "").replace("/dispatch", "").trim();
    if (!UUID.test(campaignId)) {
      sendJson(res, 400, { error: "Invalid campaign id" });
      return;
    }
    const campaign = await campaignRepository.getById(tenantId, campaignId);
    if (!campaign) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }
    const template = await templateRepository.getById(tenantId, campaign.templateId);
    if (!template) {
      sendJson(res, 409, { error: "Template not found" });
      return;
    }
    const payload = await readJsonBody<DispatchCampaignRequest>(req);
    if (!E164.test(payload.contactPhoneE164 ?? "")) {
      sendJson(res, 400, { error: "contactPhoneE164 must be E.164 formatted" });
      return;
    }
    const result = await dispatchCampaign(tenantId, campaign, template, payload);
    await audit(tenantId, auth, {
      action: "campaign.dispatch.requested",
      resourceType: "Campaign",
      resourceId: campaignId,
      payload: { parametersCount: payload.parameters?.length ?? 0 }
    });
    sendJson(res, result.status, result.body);
    return;
  }

  // Campaign: full audience fan-out (Phase 2).
  if (path.startsWith("/api/v1/campaigns/") && path.endsWith("/run") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role to run campaigns" });
      return;
    }
    const campaignId = path.replace("/api/v1/campaigns/", "").replace("/run", "").trim();
    if (!UUID.test(campaignId)) {
      sendJson(res, 400, { error: "Invalid campaign id" });
      return;
    }
    const campaign = await campaignRepository.getById(tenantId, campaignId);
    if (!campaign) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }
    const template = await templateRepository.getById(tenantId, campaign.templateId);
    if (!template) {
      sendJson(res, 409, { error: "Template not found" });
      return;
    }
    const result = await runCampaign(tenantId, campaign, template);
    if (result.status === 202) {
      await audit(tenantId, auth, {
        action: "campaign.run.requested",
        resourceType: "Campaign",
        resourceId: campaignId,
        payload: { recipientCount: (result.body.recipientCount as number) ?? 0 }
      });
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // Campaign delivery funnel report.
  if (path.startsWith("/api/v1/campaigns/") && path.endsWith("/report") && method === "GET") {
    const campaignId = path.replace("/api/v1/campaigns/", "").replace("/report", "").trim();
    if (!UUID.test(campaignId)) {
      sendJson(res, 400, { error: "Invalid campaign id" });
      return;
    }
    const campaign = await campaignRepository.getById(tenantId, campaignId);
    if (!campaign) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }
    const [funnel, recipients] = await Promise.all([
      campaignRecipientRepository.funnelCounts(tenantId, campaignId),
      campaignRecipientRepository.listByCampaign(tenantId, campaignId, { limit: 500 })
    ]);
    sendJson(res, 200, { campaign, funnel, recipients });
    return;
  }

  // ─── Conversations ─────────────────────────────────────────────────────────
  if (path === "/api/v1/conversations" && method === "GET") {
    const query = parseQuery(req.url);
    sendJson(res, 200, {
      items: await conversationRepository.list(tenantId, {
        state: query.get("state") ?? undefined,
        assignedUserId: query.get("assignee") ?? undefined
      })
    });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/assign") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = path.replace("/api/v1/conversations/", "").replace("/assign", "").trim();
    if (!UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ userId: string | null }>(req);
    await conversationRepository.assign(tenantId, conversationId, body.userId ?? null);
    sseHub.broadcast(tenantId, "conversation.assigned", randomUUID(), { conversationId, userId: body.userId });
    sendJson(res, 200, { status: "assigned", conversationId, userId: body.userId });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/state") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = path.replace("/api/v1/conversations/", "").replace("/state", "").trim();
    if (!UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ state: "open" | "pending" | "closed" }>(req);
    if (!["open", "pending", "closed"].includes(body.state)) {
      sendJson(res, 400, { error: "state must be open, pending, or closed" });
      return;
    }
    await conversationRepository.setState(tenantId, conversationId, body.state);
    sseHub.broadcast(tenantId, "conversation.state_changed", randomUUID(), { conversationId, state: body.state });
    sendJson(res, 200, { status: "updated", conversationId, state: body.state });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/messages")) {
    const conversationId = path.replace("/api/v1/conversations/", "").replace("/messages", "").trim();
    if (!UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    if (method === "GET") {
      const query = parseQuery(req.url);
      const limit = Number(query.get("limit") ?? "50");
      const before = query.get("before") ?? undefined;
      const items = await messageRepository.listByConversation(tenantId, conversationId, {
        limit: Number.isFinite(limit) ? limit : 50,
        before
      });
      sendJson(res, 200, { items });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role to send a message" });
        return;
      }
      const result = await sendConversationMessage(
        tenantId,
        conversationId,
        auth,
        await readJsonBody<SendMessageRequest>(req)
      );
      if (result.status === 202) {
        await audit(tenantId, auth, {
          action: "conversation.message.sent",
          resourceType: "Conversation",
          resourceId: conversationId,
          payload: { kind: (result.body.kind as string) ?? "text" }
        });
      }
      sendJson(res, result.status, result.body);
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Auto-reply rules ─────────────────────────────────────────────────────
  if (path === "/api/v1/auto-reply-rules") {
    if (method === "GET") {
      sendJson(res, 200, { items: await autoReplyRuleRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role" });
        return;
      }
      const payload = await readJsonBody<CreateAutoReplyRuleRequest>(req);
      const rule = await autoReplyRuleRepository.create(tenantId, payload);
      sendJson(res, 201, { ...rule });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/auto-reply-rules/") && method === "PATCH") {
    const ruleId = path.replace("/api/v1/auto-reply-rules/", "").trim();
    if (!UUID.test(ruleId)) {
      sendJson(res, 400, { error: "Invalid rule id" });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const body = await readJsonBody<{ enabled: boolean }>(req);
    await autoReplyRuleRepository.setEnabled(tenantId, ruleId, body.enabled);
    sendJson(res, 200, { status: "updated", ruleId, enabled: body.enabled });
    return;
  }

  // ─── Orders ───────────────────────────────────────────────────────────────
  if (path === "/api/v1/orders") {
    if (method === "GET") {
      sendJson(res, 200, { items: await orderRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!canCreateOrder(auth)) {
        sendJson(res, 403, { error: "Insufficient role to create orders" });
        return;
      }
      const payload = await readJsonBody<CreateOrderRequest>(req);
      if (!payload.contactId || !payload.externalOrderId || !payload.amountMinor || !payload.currency) {
        sendJson(res, 400, { error: "contactId, externalOrderId, amountMinor and currency are required" });
        return;
      }
      const order = await orderRepository.create(tenantId, payload);
      await audit(tenantId, auth, {
        action: "order.created",
        resourceType: "Order",
        resourceId: order.id,
        payload: { externalOrderId: order.externalOrderId, amountMinor: order.amountMinor }
      });
      sendJson(res, 201, { ...order });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Analytics & Audit ────────────────────────────────────────────────────
  if (path === "/api/v1/analytics" && method === "GET") {
    const totals = await tenantAnalytics(tenantId);
    sendJson(res, 200, { tenantId, totals });
    return;
  }

  if (path === "/api/v1/audit" && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "compliance_auditor"])) {
      sendJson(res, 403, { error: "Insufficient role to read audit log" });
      return;
    }
    sendJson(res, 200, { items: await auditRepository.list(tenantId) });
    return;
  }

  sendJson(res, 404, { error: "route_not_found", method, path, requestId: ctx.requestId });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  applySecurityHeaders(res);
  handle(req, res).catch((error) => {
    logger.error("request_failed", {
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

const relayTimer = startOutboxRelay();
const schedulerTimer = startCampaignScheduler();

server.listen(config.apiGatewayPort, () => {
  logger.info("service_started", {
    port: config.apiGatewayPort,
    nodeEnv: config.nodeEnv,
    authEnabled: config.authEnabled
  });
});

server.on("error", (error) => {
  logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
});

async function shutdown(signal: string): Promise<void> {
  logger.info("shutdown_started", { signal });
  clearInterval(relayTimer);
  clearInterval(schedulerTimer);
  sseHub.close();
  server.close(async () => {
    await eventBus.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    logger.info("shutdown_complete", { signal });
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
