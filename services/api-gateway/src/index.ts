import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import { loadConfig } from "@hyfib/config";
import { createAuthenticator, hasAnyRole, AuthError, type AuthContext } from "@hyfib/auth";
import { createEventBus } from "@hyfib/event-bus";
import {
  auditRepository,
  campaignRepository,
  channelRepository,
  closePool,
  consentRepository,
  contactRepository,
  conversationRepository,
  healthCheck,
  messageRepository,
  orderRepository,
  outboxRepository,
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
  readJsonBody,
  readRawBody,
  requestContext,
  sendJson,
  sendMetrics,
  incCounter,
  verifyMetaSignature,
  EventTopics,
  type MessageCategory,
  type Role,
  type Template,
  type WhatsAppMediaKind
} from "@hyfib/shared-core";

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
  /** Optional per-tenant access token; encrypted at rest when provided. */
  accessToken?: string;
}

interface SendMessageRequest {
  kind?: "text" | "media";
  text?: string;
  previewUrl?: boolean;
  media?: { mediaType: WhatsAppMediaKind; link?: string; mediaId?: string; caption?: string; filename?: string };
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
}

interface DispatchCampaignRequest {
  contactPhoneE164: string;
  parameters?: string[];
  hasActiveConsent: boolean;
  isOptedOut: boolean;
  isInside24hWindow: boolean;
  currentHourLocal: number;
  quietHours?: {
    startHour: number;
    endHour: number;
  };
  frequencyCap?: {
    maxMessages: number;
    periodHours: number;
    sentInPeriod: number;
  };
}

interface CreateContactRequest {
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  tags?: string[];
}

interface CreateOrderRequest {
  contactId: string;
  externalOrderId: string;
  amountMinor: number;
  currency: string;
}

const config = loadConfig();
const logger = new Logger("api-gateway", config.logLevel as "debug" | "info" | "warn" | "error");
const authenticator = createAuthenticator(config);
const eventBus = createEventBus(config);
const webhookIdempotency = new IdempotencyStore(24 * 60 * 60 * 1000);

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Resolves the caller identity. In normal operation this verifies the
 * Keycloak-issued JWT and derives tenant + roles from signed claims. The
 * header-based path is only reachable when AUTH_ENABLED=false (local dev).
 */
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

/**
 * Validates policy, then durably enqueues the dispatch via the transactional
 * outbox (atomic with the campaign status update). The outbox relay publishes
 * it to RabbitMQ and the message-worker performs the actual send, so this
 * returns 202 Accepted — results arrive asynchronously via status webhooks.
 */
async function dispatchCampaign(
  tenantId: string,
  campaign: CampaignWithTemplate,
  template: Template,
  payload: DispatchCampaignRequest
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Consent and opt-out are authoritative from our own records, never trusted
  // from the caller. Marketing requires a known, consented, non-opted-out contact.
  const knownContact = await contactRepository.findByPhone(tenantId, payload.contactPhoneE164);
  if (!knownContact) {
    return {
      status: 422,
      body: { error: "campaign_blocked_by_policy", reason: "Unknown contact (no consent on record)" }
    };
  }
  const isOptedOut = knownContact.optedOut;
  const hasActiveConsent = await consentRepository.hasActiveConsent(tenantId, knownContact.id);

  const policy = evaluateOutboundPolicy({
    hasActiveConsent,
    isInside24hWindow: payload.isInside24hWindow,
    template,
    requestedCategory: campaign.templateCategory,
    isOptedOut,
    currentHourLocal: payload.currentHourLocal,
    quietHours: payload.quietHours,
    frequencyCap: payload.frequencyCap
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

const META_CATEGORIES: ReadonlySet<MessageCategory> = new Set(["marketing", "utility", "authentication", "service"]);

interface MetaTemplateItem {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
}

/**
 * Pulls the channel's templates from Meta (via meta-adapter) and reconciles the
 * local catalogue, emitting template.status.updated for each change.
 */
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
    const body = (await response.json()) as { items?: MetaTemplateItem[]; error?: string };
    if (!response.ok) {
      return { status: 502, body: { error: "template_sync_failed", detail: body.error ?? "meta error" } };
    }
    items = body.items ?? [];
  } catch (error) {
    return { status: 503, body: { error: "meta_adapter_unavailable", detail: error instanceof Error ? error.message : "failed" } };
  }

  let synced = 0;
  for (const item of items) {
    const category = (item.category && META_CATEGORIES.has(item.category as MessageCategory)
      ? item.category
      : "utility") as MessageCategory;
    const status = (["approved", "rejected", "pending", "paused"].includes(item.status)
      ? item.status
      : "pending") as Template["status"];
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

/**
 * Enqueues a free-form (session) outbound message to a conversation via the
 * transactional outbox; the worker performs the actual send. Suppressed for
 * opted-out contacts. Returns 202 Accepted (asynchronous like campaign dispatch).
 */
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

  const kind = body.kind === "media" ? "media" : "text";
  if (kind === "text" && !body.text?.trim()) {
    return { status: 400, body: { error: "text is required" } };
  }
  if (kind === "media" && !body.media?.mediaType) {
    return { status: 400, body: { error: "media.mediaType is required" } };
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
        actorId: asActorUuid(auth.subject)
      }
    });
  });
  return { status: 202, body: { status: "message_enqueued", kind } };
}

/**
 * Transactional-outbox relay: claims pending events and publishes them to the
 * event bus, then marks them processed. At-least-once; consumers are idempotent.
 */
function startOutboxRelay(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
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

  // Webhook verification handshake (Meta calls this with a verify token).
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

  // Inbound webhook: authenticated by HMAC signature, not by JWT.
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

  // Everything under /api/v1 requires an authenticated, role-bearing caller.
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

  // Remaining routes operate within the caller's tenant, taken from the token.
  const tenantId = auth.tenantId;
  if (!tenantId) {
    sendJson(res, 403, { error: "Token is missing tenant_id claim" });
    return;
  }

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
        // Most likely a missing CHANNEL_ENCRYPTION_KEY when a token was supplied.
        sendJson(res, 400, { error: "channel_create_failed", detail: error instanceof Error ? error.message : "failed" });
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

  // Reconcile local templates with Meta's source of truth for this channel's WABA.
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
        templateId: payload.templateId
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

  if (path === "/api/v1/contacts") {
    if (method === "GET") {
      sendJson(res, 200, { items: await contactRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
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

  // Record opt-in consent for a contact (required before marketing sends).
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

  // Opt a contact out: revoke consent, suppress future sends, emit compliance event.
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

  if (path === "/api/v1/conversations" && method === "GET") {
    sendJson(res, 200, { items: await conversationRepository.list(tenantId) });
    return;
  }

  // Conversation thread (message history).
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
    // Agent reply: a free-form session (non-template) outbound message.
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role to send a message" });
        return;
      }
      const result = await sendConversationMessage(tenantId, conversationId, auth, await readJsonBody<SendMessageRequest>(req));
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

  if (path === "/api/v1/orders") {
    if (method === "GET") {
      sendJson(res, 200, { items: await orderRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
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
  server.close(async () => {
    await eventBus.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    logger.info("shutdown_complete", { signal });
    process.exit(0);
  });
  // Force-exit if connections do not drain in time.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
