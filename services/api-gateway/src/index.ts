import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash, scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scryptAsync = promisify(scrypt);
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import { loadConfig } from "@hyfib/config";
import { createAuthenticator, hasAnyRole, normalizeRoles, AuthError, type AuthContext } from "@hyfib/auth";
import { createEventBus, type EventBus } from "@hyfib/event-bus";
import {
  auditRepository,
  autoReplyRuleRepository,
  automationRuleRepository,
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
  mediaRepository,
  messageRepository,
  orderRepository,
  outboxRepository,
  query as dbQuery,
  resolveChannelByPhoneNumberId,
  savedReplyRepository,
  segmentRepository,
  contactNoteRepository,
  conversationNoteRepository,
  sessionRepository,
  tagRepository,
  taskRepository,
  teamRepository,
  templateRepository,
  tenantAnalytics,
  tenantRepository,
  userRepository,
  whatsappSettingsRepository,
  withTenant,
  type CampaignWithTemplate
} from "@hyfib/persistence";
import {
  RedisIdempotencyStore,
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
  verifyWebhookToken,
  EventTopics,
  evaluateAutomationRules,
  type AutomationActionConfig,
  type AutomationActionType,
  type AutomationConditions,
  type AutomationTriggerType,
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
import { getRedisClient, checkRateLimit } from "@hyfib/ratelimit";
import {
  parseContactListQuery,
  parseListQuery,
  boundedText,
  parseOptionalIsoDate,
  clampInt,
  validateInteractivePayload,
  validateCampaignBody
} from "./validation.js";
import { filterSendableContacts } from "./campaign.js";
import { canCreateContact, canCreateOrder } from "./authorization.js";
import { buildMediaHeaders } from "./media-headers.js";
import { SseHub } from "./sse-hub.js";
import { parseCsv, serializeContactsCsv, extractMultipartFile } from "./csv.js";
import { resolveOrgTenant } from "./single-org.js";
import { runOutboxRelayOnce } from "./outbox-relay.js";
import { classifyRoute, API_RATE_LIMITS } from "./rate-limit.js";
import {
  SESSION_COOKIE,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookieValue,
  csrfViolation
} from "./cookies.js";

// ─── Request body interfaces ───────────────────────────────────────────────────

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

interface UpdateWhatsAppSettingsRequest {
  statusCallbackUrl?: string;
  graphVersion?: string;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  outboundRateLimitPerMinute?: number;
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

interface CreateAutomationRuleRequest {
  name?: string;
  triggerType?: AutomationTriggerType;
  conditions?: AutomationConditions;
  actionType?: AutomationActionType;
  actionConfig?: AutomationActionConfig;
  enabled?: boolean;
  priority?: number;
}

interface CreateTaskRequest {
  title?: string;
  contactId?: string;
  conversationId?: string;
  assigneeUserId?: string;
  dueAt?: string;
  remindAt?: string;
}

const AUTOMATION_TRIGGERS = new Set<AutomationTriggerType>([
  "new_message",
  "tag_added",
  "conversation_assigned",
  "no_reply"
]);
const AUTOMATION_ACTIONS = new Set<AutomationActionType>(["send_template", "assign_agent", "add_tag", "create_task"]);
// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
const logger = new Logger("api-gateway", config.logLevel as "debug" | "info" | "warn" | "error");
const authenticator = createAuthenticator(config);
let eventBus = createEventBus(config);
const webhookIdempotency = new RedisIdempotencyStore(getRedisClient(config), 24 * 60 * 60);

// Internal proxy to the webhook-ingestor. Injectable so the modular monolith
// swaps in a direct in-process call instead of HTTP (Phase 3).
export type IngestWebhookProxy = (forwarded: { rawBody: string; signature?: string; tenantId?: string }) => Promise<{
  ok: boolean;
  body: unknown;
  /**
   * Upstream status for observability: the ingestor's HTTP status on the
   * standalone path, or the equivalent (200/401) from the in-process path.
   * Lets failure logs distinguish 401-signature from 5xx-processing.
   * Optional so custom injected proxies remain source-compatible.
   */
  status?: number;
}>;

async function defaultIngestWebhookProxy(forwarded: {
  rawBody: string;
  signature?: string;
}): Promise<{ ok: boolean; body: unknown; status?: number }> {
  const proxyResponse = await fetch(`${config.webhookIngestorUrl}/internal/v1/webhooks/meta/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-request-id": randomUUID() },
    body: JSON.stringify({ rawBody: forwarded.rawBody, signature: forwarded.signature }),
    signal: AbortSignal.timeout(10_000)
  });
  const body = (await proxyResponse.json()) as unknown;
  return { ok: proxyResponse.ok, body, status: proxyResponse.status };
}

let ingestWebhookProxy: IngestWebhookProxy = defaultIngestWebhookProxy;

// Internal proxies to the small read/AI services. Injectable so the monolith
// swaps them for direct in-process calls (Phases 6–8).
export interface ServiceProxyContext {
  tenantId: string;
  requestId: string;
}
export type ReportsOverviewProxy = (
  ctx: ServiceProxyContext
) => Promise<{ status: number; body: Record<string, unknown> }>;
export type UsageProxy = (
  ctx: ServiceProxyContext,
  days: string
) => Promise<{ status: number; body: Record<string, unknown> }>;
export type AiProxy = (
  ctx: ServiceProxyContext,
  aiPath: string,
  method: string,
  rawBody?: string
) => Promise<{ status: number; body: Record<string, unknown> }>;

async function defaultReportsOverviewProxy(
  ctx: ServiceProxyContext
): Promise<{ status: number; body: Record<string, unknown> }> {
  const upstream = await fetch(`${config.reportingServiceUrl}/internal/v1/reports/overview`, {
    headers: {
      "x-tenant-id": ctx.tenantId,
      "x-request-id": ctx.requestId,
      "x-internal-secret": config.internalServiceSecret
    },
    signal: AbortSignal.timeout(10_000)
  });
  const body = (await upstream.json()) as Record<string, unknown>;
  return { status: upstream.ok ? 200 : upstream.status, body };
}

async function defaultUsageProxy(
  ctx: ServiceProxyContext,
  days: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const upstream = await fetch(`${config.billingUsageServiceUrl}/internal/v1/usage?days=${encodeURIComponent(days)}`, {
    headers: {
      "x-tenant-id": ctx.tenantId,
      "x-request-id": ctx.requestId,
      "x-internal-secret": config.internalServiceSecret
    },
    signal: AbortSignal.timeout(10_000)
  });
  const body = (await upstream.json()) as Record<string, unknown>;
  return { status: upstream.ok ? 200 : upstream.status, body };
}

async function defaultAiProxy(
  ctx: ServiceProxyContext,
  aiPath: string,
  method: string,
  rawBody?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const upstream = await fetch(`${config.aiIntelligenceUrl}/internal/v1/ai/${aiPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": ctx.tenantId,
      "x-request-id": ctx.requestId,
      "x-internal-secret": config.internalServiceSecret
    },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
    signal: AbortSignal.timeout(90_000)
  });
  const body = (await upstream.json()) as Record<string, unknown>;
  return { status: upstream.ok ? 200 : upstream.status, body };
}

let reportsOverviewProxy: ReportsOverviewProxy = defaultReportsOverviewProxy;
let usageProxy: UsageProxy = defaultUsageProxy;
let aiProxy: AiProxy = defaultAiProxy;

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEDIA_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const CONTACTS_EXPORT_LIMIT = 50_000;

const VALID_ROLE_NAMES: ReadonlyArray<string> = [
  "platform_owner",
  "tenant_admin",
  "marketing_manager",
  "sales_agent",
  "support_agent",
  "analyst",
  "compliance_auditor"
];

/** Returns the first path segment after `prefix`, or null when absent or empty. */
function extractPathSegment(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split("/")[0] || null;
}
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

// ─── Password helpers (scrypt, no external deps) ──────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    const storedBuf = Buffer.from(hash, "hex");
    return derived.length === storedBuf.length && timingSafeEqual(derived, storedBuf);
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Resolved once at boot by bootstrapPlatformAdmin() and reused by the
// dev-mode auth header fallback (resolveAuth) as the default tenant.
let orgTenantId: string | undefined;

// Resolves the single organization this deployment serves, then creates the
// platform_owner account from env vars on first boot only. No password hash
// is ever committed to source control (see 013_auth.sql).
async function bootstrapPlatformAdmin(): Promise<void> {
  const org = await resolveOrgTenant({
    listTenants: tenantRepository.list,
    getTenantById: tenantRepository.getById,
    updateTenant: tenantRepository.update,
    env: { orgTenantId: config.orgTenantId, orgName: config.orgName },
    log: (msg, meta) => logger.info(msg, meta)
  });
  orgTenantId = org.id;

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    // Self-registration is disabled, so if the org has no users yet there is
    // no way to create the first one — surface this loudly rather than fail
    // silently at first login.
    const userCount = await tenantRepository.getUserCount(org.id);
    if (userCount === 0) {
      logger.warn("no_admin_bootstrap_configured", {
        tenantId: org.id,
        detail:
          "BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set and this org has no users. " +
          "Registration is disabled, so there is no way to create the first user."
      });
    }
    return;
  }
  if (!EMAIL.test(email) || password.length < 8) {
    logger.warn("bootstrap_admin_invalid_credentials");
    return;
  }
  const existing = await userRepository.findByEmailForAuth(email);
  if (existing) return;
  const passwordHash = await hashPassword(password);
  const user = await userRepository.create(org.id, {
    email,
    displayName: "Platform Admin",
    roles: ["platform_owner"],
    passwordHash
  });
  logger.info("platform_admin_bootstrapped", { userId: user.id, email, tenantId: org.id });
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}

const AUTH_RATE_LIMIT_PER_MINUTE = 5;

async function isAuthRateLimited(scope: string): Promise<boolean> {
  const { allowed } = await checkRateLimit(getRedisClient(config), `auth:${scope}`, AUTH_RATE_LIMIT_PER_MINUTE);
  return !allowed;
}

// ─── Session cookie helpers ─────────────────────────────────────────────────

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

/** Marks the cookie Secure whenever the connection is (or terminates) TLS. */
function isSecureRequest(req: IncomingMessage): boolean {
  return config.nodeEnv === "production" || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(res: ServerResponse, token: string, req: IncomingMessage): void {
  res.setHeader(
    "Set-Cookie",
    serializeSessionCookie(token, { secure: isSecureRequest(req), maxAgeSeconds: SESSION_TTL })
  );
}

function clearSessionCookie(res: ServerResponse, req: IncomingMessage): void {
  res.setHeader("Set-Cookie", clearSessionCookieValue(isSecureRequest(req)));
}

function cookieHeaderOf(req: IncomingMessage): string | undefined {
  return req.headers["cookie"];
}

// ─── Auth resolution: Bearer token (session) → cookie (session) → Keycloak → dev fallback

/** Resolves an opaque session token (Bearer or cookie) to an AuthContext, or undefined if unknown/expired. */
async function resolveSessionToken(rawToken: string): Promise<AuthContext | undefined> {
  const session = await sessionRepository.findByToken(tokenHash(rawToken));
  if (!session) return undefined;
  // Must resolve roles through a tenant-scoped read: users has FORCE RLS,
  // so a bare pool query silently returns zero rows (empty roles → 403s).
  const user = await userRepository.getById(session.tenantId, session.userId);
  const roles = normalizeRoles(user?.roles ?? []);
  return { subject: session.userId, tenantId: session.tenantId, roles };
}

async function resolveAuth(req: IncomingMessage): Promise<AuthContext> {
  // 1. Bearer session token (works in all modes) — takes precedence over the cookie.
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const authCtx = await resolveSessionToken(authHeader.slice(7));
    if (authCtx) return authCtx;
  }

  // 2. HttpOnly session cookie (browser clients that have switched off Bearer).
  const cookieToken = parseCookies(cookieHeaderOf(req))[SESSION_COOKIE];
  if (cookieToken) {
    const authCtx = await resolveSessionToken(cookieToken);
    if (authCtx) return authCtx;
  }

  if (config.authEnabled) {
    return authenticator.authenticate(authHeader);
  }

  // Dev-mode header fallback. An explicit x-tenant-id still wins; otherwise
  // default to the single resolved org (undefined until bootstrap has run).
  const roleHeader = req.headers["x-role"];
  const roles = normalizeRoles(typeof roleHeader === "string" ? roleHeader.split(",") : []);
  const headerTenantId =
    typeof req.headers["x-tenant-id"] === "string" ? (req.headers["x-tenant-id"] as string) : undefined;
  const tenantId = headerTenantId ?? orgTenantId;
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
 * Evaluates and executes enabled automation rules for a synchronous trigger
 * (tag_added / conversation_assigned) using the shared engine. Best-effort:
 * action failures are logged, never surfaced to the caller. send_template is
 * deferred (logged) until the template-dispatch path is wired.
 */
async function runAutomation(
  tenantId: string,
  trigger: AutomationTriggerType,
  ctx: { messageText?: string; addedTag?: string },
  target: { contactId?: string; conversationId?: string }
): Promise<void> {
  const rules = await automationRuleRepository.listEnabledByTrigger(tenantId, trigger);
  if (rules.length === 0) {
    return;
  }
  for (const action of evaluateAutomationRules(trigger, ctx, rules)) {
    try {
      if (action.kind === "add_tag" && target.contactId) {
        await tagRepository.ensure(tenantId, action.tag);
        await contactRepository.addTag(tenantId, target.contactId, action.tag);
      } else if (action.kind === "assign_agent" && target.conversationId) {
        if (await userRepository.getById(tenantId, action.assigneeUserId)) {
          await conversationRepository.assign(tenantId, target.conversationId, action.assigneeUserId);
        }
      } else if (action.kind === "create_task") {
        const minutes =
          action.dueInMinutes && action.dueInMinutes > 0 ? Math.min(action.dueInMinutes, 525_600) : undefined;
        const dueAt = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : undefined;
        await taskRepository.create(tenantId, {
          title: action.title,
          contactId: target.contactId,
          conversationId: target.conversationId,
          dueAt,
          remindAt: dueAt,
          source: "automation"
        });
      } else if (action.kind === "send_template") {
        const contact = target.contactId ? await contactRepository.getById(tenantId, target.contactId) : undefined;
        if (contact) {
          const channelId = target.conversationId
            ? (await conversationRepository.getById(tenantId, target.conversationId))?.channelId
            : undefined;
          await withTenant(tenantId, async (client) => {
            await outboxRepository.enqueue(client, tenantId, {
              topic: EventTopics.AutomationTemplateRequested,
              payload: {
                tenantId,
                channelId,
                contactPhoneE164: contact.phoneE164,
                templateName: action.templateName,
                templateLanguage: action.templateLanguage,
                dispatchId: randomUUID()
              }
            });
          });
        }
      }
      incCounter("automation_actions_executed_total", "Automation actions executed.", { action: action.kind });
    } catch (error) {
      logger.error("automation_action_failed", {
        tenantId,
        trigger,
        action: action.kind,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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

  // Final safeguard: never queue opted-out contacts, even if resolution changed.
  const { eligible, suppressed } = filterSendableContacts(contacts);
  if (eligible.length === 0) {
    return { status: 422, body: { error: "All resolved contacts are opted out", suppressed } };
  }

  const channel = await channelRepository.firstActive(tenantId);
  if (!channel) {
    return { status: 409, body: { error: "No active WhatsApp channel configured for tenant" } };
  }

  await campaignRecipientRepository.insertBatch(
    tenantId,
    campaign.id,
    eligible.map((c) => ({ id: c.id, phoneE164: c.phoneE164 }))
  );

  // Atomically claim the campaign: concurrent callers both reading 'draft' would both
  // pass the guard above, so the status update must be conditional at the DB level.
  let claimed = false;
  await withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      "UPDATE campaigns SET status = 'running' WHERE id = $1 AND status IN ('draft', 'paused') RETURNING id",
      [campaign.id]
    );
    claimed = result.rows.length > 0;
    if (claimed) {
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
    }
  });

  if (!claimed) {
    return { status: 409, body: { error: "Campaign was already started by a concurrent request" } };
  }

  return {
    status: 202,
    body: { status: "run_started", campaignId: campaign.id, recipientCount: eligible.length, suppressed }
  };
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
  let items: MetaTemplateItem[];
  try {
    const response = await fetch(url, {
      headers: {
        "x-tenant-id": tenantId,
        "x-request-id": randomUUID(),
        "x-internal-secret": config.internalServiceSecret,
        ...(channel.accessToken ? { "x-access-token": channel.accessToken } : {})
      },
      signal: AbortSignal.timeout(15_000)
    });
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

  const VALID_MESSAGE_KINDS = ["text", "media", "interactive", "product", "catalog", "flow"] as const;
  const kind = body.kind ?? "text";
  if (!VALID_MESSAGE_KINDS.includes(kind as (typeof VALID_MESSAGE_KINDS)[number])) {
    return { status: 400, body: { error: `kind must be one of: ${VALID_MESSAGE_KINDS.join(", ")}` } };
  }

  if (kind === "text") {
    if (!body.text?.trim()) {
      return { status: 400, body: { error: "text is required" } };
    }
    if (body.text.length > 4096) {
      return { status: 400, body: { error: "text must be at most 4096 characters" } };
    }
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
        actorId: asActorUuid(auth.subject),
        dispatchId: randomUUID()
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
        await runOutboxRelayOnce(
          {
            claim: (limit) => outboxRepository.claim(limit),
            publish: (topic, payload, tenantId) =>
              eventBus.publish(topic as (typeof EventTopics)[keyof typeof EventTopics], payload, tenantId),
            markProcessed: (id) => outboxRepository.markProcessed(id),
            markFailed: (id, error) => outboxRepository.markFailed(id, error),
            counters: {
              published: (topic) => incCounter("events_published_total", "Events published to the bus.", { topic }),
              failed: (topic) =>
                incCounter("outbox_publish_failures_total", "Outbox row publish attempts that failed.", { topic }),
              dead: (topic) =>
                incCounter(
                  "outbox_events_dead_total",
                  "Outbox rows moved to dead-letter status after exhausting retries.",
                  { topic }
                )
            },
            logger
          },
          50
        );
      } finally {
        running = false;
      }
    })();
  }, 1_000);
}

// ─── Campaign scheduler ────────────────────────────────────────────────────────

function startCampaignScheduler(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
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
        }>(`SELECT * FROM due_scheduled_campaigns($1)`, [20]);
        for (const row of result.rows) {
          await withTenant(row.tenant_id, async (client) => {
            if (row.segment_id) {
              const seg = await segmentRepository.getById(row.tenant_id, row.segment_id);
              if (seg) {
                const contacts = await segmentRepository.resolveContacts(row.tenant_id, seg.definition);
                const { eligible } = filterSendableContacts(contacts);
                await campaignRecipientRepository.insertBatch(
                  row.tenant_id,
                  row.id,
                  eligible.map((c) => ({ id: c.id, phoneE164: c.phoneE164 }))
                );
              }
            }
            const channel = await channelRepository.firstActive(row.tenant_id);
            if (!channel) return;
            const claimed = await client.query<{ id: string }>(
              "UPDATE campaigns SET status = 'running', scheduled_at = NULL WHERE id = $1 AND status = 'scheduled' RETURNING id",
              [row.id]
            );
            if (claimed.rows.length === 0) return; // Another scheduler instance already claimed it.
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
      } finally {
        running = false;
      }
    })();
  }, 30_000);
}

/**
 * Fires `no_reply` automation rules for open conversations whose last activity
 * was an inbound message older than the rule's delay, with no agent reply since.
 * `no_reply_fired_at` de-dupes until a new inbound arrives.
 */
function startNoReplyScheduler(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const due = await dbQuery<{
          id: string;
          tenant_id: string;
          contact_id: string;
          last_inbound_at: Date | null;
        }>(`SELECT * FROM due_no_reply_conversations($1)`, [50]);
        for (const row of due.rows) {
          const rules = await automationRuleRepository.listEnabledByTrigger(row.tenant_id, "no_reply");
          const idleMs = row.last_inbound_at ? Date.now() - row.last_inbound_at.getTime() : 0;
          const anyDue = rules.some((r) => idleMs >= (r.conditions.delayMinutes ?? 60) * 60_000);
          if (!anyDue) {
            continue;
          }
          await runAutomation(row.tenant_id, "no_reply", {}, { conversationId: row.id, contactId: row.contact_id });
          await withTenant(row.tenant_id, async (client) => {
            await client.query("UPDATE conversations SET no_reply_fired_at = now() WHERE id = $1", [row.id]);
          });
        }
      } catch (error) {
        logger.error("no_reply_scheduler_error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
    })();
  }, 60_000);
}

/** Dispatches due task reminders (status open, remind_at passed) once via SSE. */
function startReminderScheduler(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const due = await dbQuery<{ id: string; tenant_id: string; title: string }>(
          `SELECT * FROM due_task_reminders($1)`,
          [50]
        );
        for (const row of due.rows) {
          await withTenant(row.tenant_id, async (client) => {
            await client.query("UPDATE tasks SET reminded_at = now() WHERE id = $1", [row.id]);
          });
          sseHub.broadcast(row.tenant_id, "task.reminder", randomUUID(), { taskId: row.id, title: row.title });
        }
      } catch (error) {
        logger.error("reminder_scheduler_error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
    })();
  }, 60_000);
}

function startSessionPurgeScheduler(): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await sessionRepository.deleteExpired();
      } catch (error) {
        logger.error("session_purge_scheduler_error", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        running = false;
      }
    })();
  }, 60 * 60_000);
}

// ─── SSE hub ──────────────────────────────────────────────────────────────────

/** Minimal LRU cache backed by Map insertion-order. Evicts the oldest entry (not the LRU access order, which is fine for this near-static phoneNumberId→tenantId mapping). */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number) {}
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  set(key: K, value: V): void {
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      this.map.delete(this.map.keys().next().value as K);
    }
    this.map.set(key, value);
  }
}

const sseHub = new SseHub();
const sseTenantByPhoneNumberId = new LruCache<string, string>(1_000);

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

/**
 * Subscribe SSE fan-out to the (possibly shared) event bus and start the
 * keep-alive ticker. Deferred out of module scope so the modular monolith can
 * inject its shared bus via createGatewayHandler() before any subscription is
 * registered; the standalone entrypoint calls it too.
 */
function registerSseForwarding(): void {
  eventBus.subscribe(EventTopics.WhatsAppInboundReceived, `${sseQueuePrefix}.inbound`, forwardEventToSse, {
    ephemeral: true
  });
  eventBus.subscribe(EventTopics.WhatsAppStatusUpdated, `${sseQueuePrefix}.status`, forwardEventToSse, {
    ephemeral: true
  });
  eventBus.subscribe(EventTopics.MediaStored, `${sseQueuePrefix}.media`, forwardEventToSse, {
    ephemeral: true
  });
  sseHub.startKeepAlive();
}

// ─── Request handler ───────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = parseUrlPath(req.url);
  const ctx = requestContext(req);
  incCounter("http_requests_total", "Total HTTP requests received.", { service: "api-gateway" });

  // ─── CSRF gate ────────────────────────────────────────────────────────────
  // Runs before every route dispatch, including webhooks/login/register: the
  // path-exemptions inside csrfViolation() guarantee those are unaffected.
  // Only blocks mutating, cookie-authenticated requests with no Bearer header
  // and no x-requested-with marker — see cookies.ts for the full rationale.
  if (csrfViolation(method, path, req.headers)) {
    sendJson(res, 403, { error: "csrf_header_required" });
    return;
  }

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
      verifyWebhookToken(query.get("hub.verify_token"), config.webhookVerifyToken) &&
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
    const signatureKey = `webhook:${normalizedSignature}`;
    if (await webhookIdempotency.isDuplicate(signatureKey)) {
      sendJson(res, 200, { status: "duplicate_ignored" });
      return;
    }
    // Reject unknown phone_number_id early to avoid silent drops downstream
    let parsedWebhookBody: Record<string, unknown> | undefined;
    try {
      parsedWebhookBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      // Non-JSON body — pass through and let ingestor handle it
    }
    if (parsedWebhookBody) {
      const firstEntry = (parsedWebhookBody?.entry as unknown[])?.[0] as Record<string, unknown> | undefined;
      const firstChange = (firstEntry?.changes as unknown[])?.[0] as Record<string, unknown> | undefined;
      const phoneNumberId = (firstChange?.value as Record<string, unknown> | undefined)?.metadata as
        | Record<string, unknown>
        | undefined;
      const phoneNumberIdStr = phoneNumberId?.phone_number_id as string | undefined;
      if (phoneNumberIdStr) {
        const resolved = await resolveChannelByPhoneNumberId(phoneNumberIdStr);
        if (!resolved) {
          logger.warn("webhook_unknown_phone_number_id", { phoneNumberId: phoneNumberIdStr });
          sendJson(res, 200, { status: "channel_not_found" }); // always 200 to Meta
          return;
        }
      }
    }
    try {
      // Two call paths land here, and only one of them throws:
      //  1. In-process proxy (app-server monolith, proxyWebhookToIngestor):
      //     processForwardedWebhook/ingestMetaWebhook throws when the outbox
      //     enqueue/publish fails (e.g. DB outage) — handled by the catch
      //     block below. It returns normally (ok:false) only when the
      //     signature failed to verify downstream, with body.status ===
      //     "invalid_signature" — not a processing failure.
      //  2. Standalone HTTP proxy (defaultIngestWebhookProxy): fetch() only
      //     throws on network errors, not HTTP error statuses, so a 5xx from
      //     the webhook-ingestor service (e.g. its own DB outage) surfaces as
      //     a normal ok:false return here, never via the catch block.
      const {
        ok,
        body: proxyBody,
        status: upstreamStatus
      } = await ingestWebhookProxy({ rawBody, signature: normalizedSignature });
      if (!ok) {
        const isInvalidSignature =
          typeof proxyBody === "object" &&
          proxyBody !== null &&
          (proxyBody as { status?: unknown }).status === "invalid_signature";
        // 401-signature vs 5xx-processing are different operational problems;
        // surface the upstream status so dashboards can tell them apart.
        logger.warn("webhook_upstream_failed", {
          requestId: ctx.requestId,
          upstreamStatus,
          invalidSignature: isInvalidSignature
        });
        if (!isInvalidSignature) {
          // Genuine processing failure reported without a throw (path 2
          // above, and defensively any future non-throwing failure of path
          // 1). Release the signature key so Meta's retry of the same
          // delivery isn't swallowed as a duplicate. Invalid-signature
          // responses intentionally skip this — pre-existing dedupe
          // semantics for bad signatures stay unchanged.
          try {
            await webhookIdempotency.release(signatureKey);
          } catch (releaseError) {
            logger.warn("idempotency_release_failed", {
              key: signatureKey,
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            });
          }
        }
      }
      sendJson(res, ok ? 200 : 502, { requestId: ctx.requestId, upstream: proxyBody });
    } catch (error) {
      // The signature-level idempotency key was claimed before this call.
      // Processing failed (e.g. outbox enqueue hit a DB outage) before the
      // webhook was durably recorded, so release the key: Meta will retry
      // the same delivery and it must not be swallowed as a duplicate. Guard
      // the release itself: if it also fails, log that separately and still
      // respond based on the ORIGINAL error, not the release failure.
      try {
        await webhookIdempotency.release(signatureKey);
      } catch (releaseError) {
        logger.warn("idempotency_release_failed", {
          key: signatureKey,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError)
        });
      }
      logger.error("webhook_ingest_failed", { error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 502, { error: "webhook_processing_unavailable" });
    }
    return;
  }

  if (!path.startsWith("/api/v1/") && !path.startsWith("/auth/")) {
    sendJson(res, 404, { error: "route_not_found", method, path, requestId: ctx.requestId });
    return;
  }

  // ─── Auth routes (unauthenticated) ────────────────────────────────────────
  // Retired: this deployment is single-organization (see single-org.ts /
  // bootstrapPlatformAdmin). The route is matched deliberately so callers get
  // an explicit 410 instead of a 404 fall-through.
  if (path === "/auth/register" && method === "POST") {
    sendJson(res, 410, {
      error: "registration_disabled",
      detail: "This deployment is single-organization; ask an admin to invite you."
    });
    return;
  }

  if (path === "/auth/login" && method === "POST") {
    if (await isAuthRateLimited(`login:${getClientIp(req)}`)) {
      sendJson(res, 429, { error: "Too many login attempts. Try again later." });
      return;
    }
    const body = await readJsonBody<{ email: string; password: string }>(req);
    if (!body.email || !body.password) {
      sendJson(res, 400, { error: "email and password are required" });
      return;
    }
    if (await isAuthRateLimited(`login-email:${body.email.toLowerCase()}`)) {
      sendJson(res, 429, { error: "Too many login attempts. Try again later." });
      return;
    }
    const found = await userRepository.findByEmailForAuth(body.email);
    if (!found || !found.passwordHash) {
      sendJson(res, 401, { error: "Invalid email or password" });
      return;
    }
    if (found.status === "suspended") {
      sendJson(res, 403, { error: "Account is suspended" });
      return;
    }
    const valid = await verifyPassword(body.password, found.passwordHash);
    if (!valid) {
      sendJson(res, 401, { error: "Invalid email or password" });
      return;
    }
    const tenant = await tenantRepository.getById(found.tenantId);
    if (tenant?.status === "suspended") {
      sendJson(res, 403, { error: "Organization account is suspended" });
      return;
    }
    const rawToken = randomUUID() + randomUUID();
    await sessionRepository.create({
      userId: found.id,
      tenantId: found.tenantId,
      tokenHash: tokenHash(rawToken),
      ttlSeconds: SESSION_TTL
    });
    setSessionCookie(res, rawToken, req);
    logger.info("user_login", { tenantId: found.tenantId, userId: found.id, email: body.email });
    sendJson(res, 200, {
      token: rawToken,
      user: {
        id: found.id,
        email: found.email,
        displayName: found.displayName,
        roles: found.roles,
        tenantId: found.tenantId,
        tenant
      }
    });
    return;
  }

  if (path === "/auth/logout" && method === "POST") {
    // Task 19 Part 2: a plain `bearerToken ?? cookieToken` (the previous
    // behavior) revokes only the FIRST token present — a stale/wrong bearer
    // (e.g. leftover localStorage value from before Task 18's cookie
    // migration) alongside a valid, live cookie session would leave that
    // cookie session un-revoked while still reporting success. deleteByToken
    // is a no-op DELETE when the hash matches no row, so attempting it for
    // both distinct tokens (when present) is harmless and revokes whichever
    // one(s) actually resolve to a live session. The cookie is always
    // cleared regardless of what (if anything) was found server-side.
    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const cookieToken = parseCookies(cookieHeaderOf(req))[SESSION_COOKIE];
    if (bearerToken) {
      await sessionRepository.deleteByToken(tokenHash(bearerToken));
    }
    if (cookieToken && cookieToken !== bearerToken) {
      await sessionRepository.deleteByToken(tokenHash(cookieToken));
    }
    clearSessionCookie(res, req);
    sendJson(res, 200, { status: "logged_out" });
    return;
  }

  if (path === "/auth/me" && method === "GET") {
    // Task 19 Part 2: bearer takes precedence (matches resolveAuth), but a
    // stale/wrong bearer must not shadow a live cookie session — the
    // previous `bearerToken ?? cookieToken` never looked at the cookie once
    // *any* bearer header was present, so a leftover/invalid localStorage
    // token (e.g. from before Task 18's cookie migration) 401'd callers who
    // had a perfectly valid cookie session. Fall through to the cookie only
    // when the bearer is present but doesn't resolve to a live session.
    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const cookieToken = parseCookies(cookieHeaderOf(req))[SESSION_COOKIE];

    let rawToken = bearerToken;
    let session = rawToken ? await sessionRepository.findByToken(tokenHash(rawToken)) : undefined;
    if (!session && cookieToken && cookieToken !== bearerToken) {
      rawToken = cookieToken;
      session = await sessionRepository.findByToken(tokenHash(rawToken));
    }
    if (!rawToken) {
      sendJson(res, 401, { error: "Not authenticated" });
      return;
    }
    if (!session) {
      sendJson(res, 401, { error: "Session expired or invalid" });
      return;
    }
    const u = await userRepository.getById(session.tenantId, session.userId);
    if (!u) {
      sendJson(res, 401, { error: "User not found" });
      return;
    }
    const tenant = await tenantRepository.getById(session.tenantId);
    // Silent upgrade: an existing localStorage/Bearer session gets an
    // HttpOnly cookie issued the first time it hits /auth/me without one
    // already present. Cookie-authenticated calls (bearerToken absent, or a
    // stale bearer that fell through to a cookie above) never re-set —
    // `!cookieToken` is false in both those cases, so nothing changed for
    // them.
    if (bearerToken && !cookieToken) {
      setSessionCookie(res, bearerToken, req);
    }
    sendJson(res, 200, {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      roles: u.roles,
      status: u.status,
      tenantId: session.tenantId,
      tenant
    });
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

  // ─── General API rate limiting ───────────────────────────────────────────
  // Placed after auth resolves (subject is known) and before any route
  // handler runs, so every /api/v1/* route below is covered. /auth/login,
  // /auth/register, /auth/logout, and /auth/me are handled earlier in the
  // auth-routes section above and all return before resolveAuth() runs, so
  // this gate structurally never sees them — login/register already have
  // their own 5/min limiter (isAuthRateLimited), and logout/me are cheap,
  // session-guarded reads/writes that don't warrant a bolted-on IP-keyed
  // check of their own (see classifyRoute's doc comment in rate-limit.ts,
  // rule 5, for the full rationale — Task 19 Part 2).
  const rlClass = classifyRoute(method, path);
  if (rlClass !== "exempt") {
    const subject = asActorUuid(auth.subject) ?? getClientIp(req);
    const { allowed, waitMs } = await checkRateLimit(
      getRedisClient(config),
      `api:${rlClass}:${subject}`,
      API_RATE_LIMITS[rlClass]
    );
    if (!allowed) {
      incCounter("rate_limited_total", "Requests rejected by the general API rate limiter.", { class: rlClass });
      res.setHeader("Retry-After", String(Math.ceil(waitMs / 1000)));
      sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: Math.ceil(waitMs / 1000) });
      return;
    }
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
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role to list users" });
        return;
      }
      const users = await userRepository.list(tenantId);
      const isAdmin = hasAnyRole(auth, ["platform_owner", "tenant_admin"]);
      const items = isAdmin ? users : users.map(({ id, displayName }) => ({ id, displayName }));
      sendJson(res, 200, { items });
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
      const emailTrimmed = payload.email.trim();
      if (!EMAIL.test(emailTrimmed)) {
        sendJson(res, 400, { error: "email must be a valid email address" });
        return;
      }
      if (!Array.isArray(payload.roles)) {
        sendJson(res, 400, { error: "roles must be an array" });
        return;
      }
      const invalidRoles = payload.roles.filter((r: unknown) => !VALID_ROLE_NAMES.includes(r as string));
      if (invalidRoles.length > 0) {
        sendJson(res, 400, { error: `Invalid roles: ${invalidRoles.join(", ")}` });
        return;
      }
      const existingUser = await userRepository.findByEmailForAuth(emailTrimmed);
      if (existingUser) {
        sendJson(res, 409, { error: "A user with this email already exists" });
        return;
      }
      // Generate a temp password the admin must share with the invitee
      const tempPassword = randomBytes(8).toString("hex");
      const pwHash = await hashPassword(tempPassword);
      const user = await userRepository.create(tenantId, {
        email: emailTrimmed,
        displayName: payload.displayName.trim(),
        roles: payload.roles,
        passwordHash: pwHash
      });
      await audit(tenantId, auth, {
        action: "user.created",
        resourceType: "User",
        resourceId: user.id,
        payload: { email: user.email, roles: user.roles }
      });
      sendJson(res, 201, { ...user, tempPassword });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // POST /api/v1/users/:id/set-password — user sets their own password
  if (path.match(/^\/api\/v1\/users\/[^/]+\/set-password$/) && method === "POST") {
    const userId = extractPathSegment(path, "/api/v1/users/");
    if (!userId || !UUID.test(userId)) {
      sendJson(res, 400, { error: "Invalid user id" });
      return;
    }
    if (auth.subject !== userId && !hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Can only change your own password" });
      return;
    }
    const body = await readJsonBody<{ password: string }>(req);
    if (!body.password || body.password.length < 8) {
      sendJson(res, 400, { error: "Password must be at least 8 characters" });
      return;
    }
    await userRepository.updatePassword(tenantId, userId, await hashPassword(body.password));
    await sessionRepository.deleteAllForUser(userId);
    sendJson(res, 200, { status: "password_updated" });
    return;
  }

  // PATCH /api/v1/users/:id — tenant_admin updates user status/roles
  if (path.match(/^\/api\/v1\/users\/[^/]+$/) && method === "PATCH") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const userId = extractPathSegment(path, "/api/v1/users/");
    if (!userId || !UUID.test(userId)) {
      sendJson(res, 400, { error: "Invalid user id" });
      return;
    }
    const body = await readJsonBody<{ status?: string }>(req);
    if (body.status) {
      await userRepository.updateStatus(tenantId, userId, body.status);
    }
    sendJson(res, 200, { status: "updated" });
    return;
  }

  // ─── Teams ────────────────────────────────────────────────────────────────
  if (path === "/api/v1/teams") {
    if (method === "GET") {
      sendJson(res, 200, { items: await teamRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
        sendJson(res, 403, { error: "Only platform_owner/tenant_admin can create teams" });
        return;
      }
      const body = await readJsonBody<{ name?: string; isDefault?: boolean }>(req);
      const nameCheck = boundedText(body.name, 120);
      if (!nameCheck.ok) {
        sendJson(res, 400, { error: `name ${nameCheck.error}` });
        return;
      }
      const team = await teamRepository.create(tenantId, { name: nameCheck.value, isDefault: body.isDefault });
      await audit(tenantId, auth, {
        action: "team.created",
        resourceType: "Team",
        resourceId: team.id,
        payload: { name: team.name }
      });
      sendJson(res, 201, { ...team });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/teams/") && path.endsWith("/members")) {
    const teamId = extractPathSegment(path, "/api/v1/teams/");
    if (!teamId || !UUID.test(teamId)) {
      sendJson(res, 400, { error: "Invalid team id" });
      return;
    }
    if (!(await teamRepository.getById(tenantId, teamId))) {
      sendJson(res, 404, { error: "Team not found" });
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, { items: await teamRepository.listMembers(tenantId, teamId) });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Only platform_owner/tenant_admin can manage members" });
      return;
    }
    const body = await readJsonBody<{ userId?: string }>(req);
    if (!body.userId || !UUID.test(body.userId)) {
      sendJson(res, 400, { error: "userId must be a valid id" });
      return;
    }
    if (!(await userRepository.getById(tenantId, body.userId))) {
      sendJson(res, 422, { error: "userId does not belong to this tenant" });
      return;
    }
    if (method === "POST") {
      await teamRepository.addMember(tenantId, teamId, body.userId);
      sendJson(res, 200, { status: "member_added", teamId, userId: body.userId });
      return;
    }
    if (method === "DELETE") {
      await teamRepository.removeMember(tenantId, teamId, body.userId);
      sendJson(res, 200, { status: "member_removed", teamId, userId: body.userId });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (/^\/api\/v1\/teams\/[^/]+$/.test(path) && method === "PATCH") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Insufficient role to update team" });
      return;
    }
    const teamId = path.split("/").at(-1)!;
    const body = await readJsonBody<{ name?: string }>(req);
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const updated = await teamRepository.update(tenantId, teamId, { name: body.name.trim() });
    if (!updated) {
      sendJson(res, 404, { error: "Team not found" });
      return;
    }
    await audit(tenantId, auth, {
      action: "team.updated",
      resourceType: "Team",
      resourceId: teamId,
      payload: { name: body.name }
    });
    sendJson(res, 200, updated as unknown as Record<string, unknown>);
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
      const wabaIdCheck = boundedText(payload.wabaId, 64);
      if (!wabaIdCheck.ok) {
        sendJson(res, 400, { error: `wabaId ${wabaIdCheck.error}` });
        return;
      }
      const phoneNumberIdCheck = boundedText(payload.phoneNumberId, 64);
      if (!phoneNumberIdCheck.ok) {
        sendJson(res, 400, { error: `phoneNumberId ${phoneNumberIdCheck.error}` });
        return;
      }
      const displayPhoneCheck = boundedText(payload.displayPhoneNumber, 32);
      if (!displayPhoneCheck.ok) {
        sendJson(res, 400, { error: `displayPhoneNumber ${displayPhoneCheck.error}` });
        return;
      }
      if (payload.accessToken !== undefined) {
        if (typeof payload.accessToken !== "string" || payload.accessToken.length > 4096) {
          sendJson(res, 400, { error: "accessToken must be a string of at most 4096 characters" });
          return;
        }
      }
      let channel;
      try {
        channel = await channelRepository.create(tenantId, {
          wabaId: wabaIdCheck.value,
          phoneNumberId: phoneNumberIdCheck.value,
          displayPhoneNumber: displayPhoneCheck.value,
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

  // ─── WhatsApp settings (retry/rate-limit config; secrets never returned) ──
  if (path === "/api/v1/channels/whatsapp/settings") {
    if (method === "GET") {
      const stored = await whatsappSettingsRepository.getByTenant(tenantId);
      sendJson(res, 200, {
        settings: stored ?? {
          graphVersion: config.whatsappGraphVersion,
          retryMaxAttempts: config.whatsappDefaultRetryMaxAttempts,
          retryBaseDelayMs: config.whatsappDefaultRetryBaseDelayMs
        }
      });
      return;
    }
    if (method === "PUT") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
        sendJson(res, 403, { error: "Only platform_owner/tenant_admin can update WhatsApp settings" });
        return;
      }
      const payload = await readJsonBody<UpdateWhatsAppSettingsRequest>(req);
      const settings = await whatsappSettingsRepository.upsert(tenantId, {
        statusCallbackUrl: payload.statusCallbackUrl?.trim() || undefined,
        graphVersion: payload.graphVersion?.trim() || config.whatsappGraphVersion,
        retryMaxAttempts: clampInt(payload.retryMaxAttempts, 1, 10, config.whatsappDefaultRetryMaxAttempts),
        retryBaseDelayMs: clampInt(payload.retryBaseDelayMs, 50, 60_000, config.whatsappDefaultRetryBaseDelayMs),
        outboundRateLimitPerMinute:
          payload.outboundRateLimitPerMinute === undefined
            ? undefined
            : clampInt(payload.outboundRateLimitPerMinute, 1, 6_000, 60)
      });
      await audit(tenantId, auth, {
        action: "channel.whatsapp.settings.updated",
        resourceType: "WhatsAppSettings",
        resourceId: settings.id,
        payload: { graphVersion: settings.graphVersion, retryMaxAttempts: settings.retryMaxAttempts }
      });
      sendJson(res, 200, { settings });
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
    const channelId = extractPathSegment(path, "/api/v1/channels/whatsapp/");
    if (!channelId || !UUID.test(channelId)) {
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
    const channelId = extractPathSegment(path, "/api/v1/channels/whatsapp/");
    if (!channelId || !UUID.test(channelId)) {
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
          "x-internal-secret": config.internalServiceSecret,
          ...(channel.accessToken ? { "x-access-token": channel.accessToken } : {})
        },
        body: new Uint8Array(buffer),
        signal: AbortSignal.timeout(30_000)
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
      const statusFilter = parseQuery(req.url).get("status") ?? undefined;
      const templates = await templateRepository.list(tenantId, { status: statusFilter });
      sendJson(res, 200, { items: templates });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role to create templates" });
        return;
      }
      const payload = await readJsonBody<CreateTemplateRequest>(req);
      const templateNameCheck = boundedText(payload.name, 512);
      if (!templateNameCheck.ok) {
        sendJson(res, 400, { error: `name ${templateNameCheck.error}` });
        return;
      }
      const TEMPLATE_CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;
      if (!TEMPLATE_CATEGORIES.includes(payload.category as (typeof TEMPLATE_CATEGORIES)[number])) {
        sendJson(res, 400, { error: `category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}` });
        return;
      }
      const templateLangCheck = boundedText(payload.language, 10);
      if (!templateLangCheck.ok) {
        sendJson(res, 400, { error: `language ${templateLangCheck.error}` });
        return;
      }
      const templateBodyCheck = boundedText(payload.body, 1024);
      if (!templateBodyCheck.ok) {
        sendJson(res, 400, { error: `body ${templateBodyCheck.error}` });
        return;
      }
      const template = await templateRepository.create(tenantId, {
        name: templateNameCheck.value,
        category: payload.category,
        language: templateLangCheck.value,
        body: templateBodyCheck.value,
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
    const segmentId = extractPathSegment(path, "/api/v1/segments/");
    if (!segmentId || !UUID.test(segmentId)) {
      sendJson(res, 400, { error: "Invalid segment id" });
      return;
    }
    const segment = await segmentRepository.getById(tenantId, segmentId);
    if (!segment) {
      sendJson(res, 404, { error: "Segment not found" });
      return;
    }
    const [count, sample] = await Promise.all([
      segmentRepository.previewCount(tenantId, segment.definition),
      segmentRepository.resolveContactsSample(tenantId, segment.definition, 5)
    ]);
    sendJson(res, 200, { count, sample });
    return;
  }

  // ─── Contacts ─────────────────────────────────────────────────────────────
  if (path === "/api/v1/contacts") {
    if (method === "GET") {
      const q = parseContactListQuery(parseQuery(req.url));
      const { items, total } = await contactRepository.search(tenantId, q);
      sendJson(res, 200, { items, total, limit: q.limit, offset: q.offset });
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
      if (
        payload.firstName !== undefined &&
        (typeof payload.firstName !== "string" || payload.firstName.length > 100)
      ) {
        sendJson(res, 400, { error: "firstName must be a string of at most 100 characters" });
        return;
      }
      if (payload.lastName !== undefined && (typeof payload.lastName !== "string" || payload.lastName.length > 100)) {
        sendJson(res, 400, { error: "lastName must be a string of at most 100 characters" });
        return;
      }
      if (payload.country !== undefined && (typeof payload.country !== "string" || payload.country.length > 100)) {
        sendJson(res, 400, { error: "country must be a string of at most 100 characters" });
        return;
      }
      if (payload.timezone !== undefined && (typeof payload.timezone !== "string" || payload.timezone.length > 64)) {
        sendJson(res, 400, { error: "timezone must be a string of at most 64 characters" });
        return;
      }
      if (payload.tags !== undefined) {
        if (!Array.isArray(payload.tags) || payload.tags.length > 50) {
          sendJson(res, 400, { error: "tags must be an array of at most 50 items" });
          return;
        }
        if (payload.tags.some((t: unknown) => typeof t !== "string" || t.length > 100)) {
          sendJson(res, 400, { error: "each tag must be a string of at most 100 characters" });
          return;
        }
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

  // ─── Contact CSV export ───────────────────────────────────────────────────
  if (path === "/api/v1/contacts/export" && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role to export contacts" });
      return;
    }
    const q = parseContactListQuery(parseQuery(req.url));
    const { items } = await contactRepository.search(tenantId, { ...q, limit: CONTACTS_EXPORT_LIMIT, offset: 0 });
    const truncated = items.length === CONTACTS_EXPORT_LIMIT;
    const csv = serializeContactsCsv(items);
    await audit(tenantId, auth, {
      action: "contacts.exported",
      resourceType: "Contact",
      payload: { count: items.length, truncated }
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="contacts.csv"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Export-Count", String(items.length));
    if (truncated) res.setHeader("X-Export-Truncated", "true");
    res.end(csv);
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
    // Strip multipart envelope if the UI sent FormData
    if (contentType.startsWith("multipart/form-data")) {
      const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
      if (boundaryMatch?.[1]) {
        const extracted = extractMultipartFile(csvBuffer, boundaryMatch[1]);
        if (extracted && extracted.length > 0) csvBuffer = extracted;
      }
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
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const contact = await contactRepository.getById(tenantId, contactId);
    if (!contact) {
      sendJson(res, 404, { error: "Contact not found" });
      return;
    }
    const body = await readJsonBody<{ source?: string; policyVersion?: string }>(req);
    if (body.source !== undefined && (typeof body.source !== "string" || body.source.length > 64)) {
      sendJson(res, 400, { error: "source must be a string of at most 64 characters" });
      return;
    }
    if (
      body.policyVersion !== undefined &&
      (typeof body.policyVersion !== "string" || body.policyVersion.length > 32)
    ) {
      sendJson(res, 400, { error: "policyVersion must be a string of at most 32 characters" });
      return;
    }
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
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const contact = await contactRepository.getById(tenantId, contactId);
    if (!contact) {
      sendJson(res, 404, { error: "Contact not found" });
      return;
    }
    const body = await readJsonBody<{ reason?: string }>(req);
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 256)) {
      sendJson(res, 400, { error: "reason must be a string of at most 256 characters" });
      return;
    }
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

  // ─── Contact notes ────────────────────────────────────────────────────────
  if (path.startsWith("/api/v1/contacts/") && path.endsWith("/notes")) {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
      sendJson(res, 403, { error: "Insufficient role to access contact notes" });
      return;
    }
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, { items: await contactNoteRepository.list(tenantId, contactId) });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody<{ note?: string }>(req);
      const noteCheck = boundedText(body.note, 4096);
      if (!noteCheck.ok) {
        sendJson(res, 400, { error: `note ${noteCheck.error}` });
        return;
      }
      const note = await contactNoteRepository.add(tenantId, {
        contactId,
        authorUserId: asActorUuid(auth.subject),
        note: noteCheck.value
      });
      await audit(tenantId, auth, {
        action: "contact.note.added",
        resourceType: "Contact",
        resourceId: contactId,
        payload: { noteId: note.id }
      });
      sendJson(res, 201, { ...note });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Contact tags ─────────────────────────────────────────────────────────
  if (path.startsWith("/api/v1/contacts/") && path.endsWith("/tags")) {
    if (!canCreateContact(auth)) {
      sendJson(res, 403, { error: "Insufficient role to modify tags" });
      return;
    }
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const body = await readJsonBody<{ tag?: string }>(req);
    const tagCheck = boundedText(body.tag, 64);
    if (!tagCheck.ok) {
      sendJson(res, 400, { error: `tag ${tagCheck.error}` });
      return;
    }
    const tag = tagCheck.value;
    if (method === "POST") {
      const existing = await contactRepository.getById(tenantId, contactId);
      if (!existing) {
        sendJson(res, 404, { error: "Contact not found" });
        return;
      }
      if (existing.tags.length >= 50 && !existing.tags.includes(tag)) {
        sendJson(res, 422, { error: "contact has reached the maximum of 50 tags" });
        return;
      }
      await tagRepository.ensure(tenantId, tag);
      await contactRepository.addTag(tenantId, contactId, tag);
      await runAutomation(tenantId, "tag_added", { addedTag: tag }, { contactId });
      sendJson(res, 200, { status: "tagged", contactId, tag });
      return;
    }
    if (method === "DELETE") {
      await contactRepository.removeTag(tenantId, contactId, tag);
      sendJson(res, 200, { status: "untagged", contactId, tag });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Contact custom fields ────────────────────────────────────────────────
  if (path.startsWith("/api/v1/contacts/") && path.endsWith("/fields") && method === "PATCH") {
    if (!canCreateContact(auth)) {
      sendJson(res, 403, { error: "Insufficient role to modify custom fields" });
      return;
    }
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const body = await readJsonBody<{ key?: string; value?: string | null }>(req);
    const keyCheck = boundedText(body.key, 64);
    if (!keyCheck.ok) {
      sendJson(res, 400, { error: `key ${keyCheck.error}` });
      return;
    }
    let value: string | null = null;
    if (body.value !== undefined && body.value !== null && body.value !== "") {
      const valueCheck = boundedText(body.value, 512);
      if (!valueCheck.ok) {
        sendJson(res, 400, { error: `value ${valueCheck.error}` });
        return;
      }
      value = valueCheck.value;
    }
    await contactRepository.setCustomField(tenantId, contactId, keyCheck.value, value);
    sendJson(res, 200, { status: "updated", contactId, key: keyCheck.value });
    return;
  }

  // ─── Contact profile (single) ─────────────────────────────────────────────
  if (path.startsWith("/api/v1/contacts/") && method === "GET") {
    const contactId = extractPathSegment(path, "/api/v1/contacts/");
    if (!contactId || !UUID.test(contactId)) {
      sendJson(res, 400, { error: "Invalid contact id" });
      return;
    }
    const contact = await contactRepository.getById(tenantId, contactId);
    if (!contact) {
      sendJson(res, 404, { error: "Contact not found" });
      return;
    }
    sendJson(res, 200, { ...contact });
    return;
  }

  // ─── Tag catalog ──────────────────────────────────────────────────────────
  if (path === "/api/v1/tags") {
    if (method === "GET") {
      sendJson(res, 200, { items: await tagRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!canCreateContact(auth)) {
        sendJson(res, 403, { error: "Insufficient role to create tags" });
        return;
      }
      const body = await readJsonBody<{ name?: string; color?: string }>(req);
      if (!body.name?.trim()) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const tag = await tagRepository.ensure(tenantId, body.name.trim(), body.color?.trim());
      sendJson(res, 201, { ...tag });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Campaigns ────────────────────────────────────────────────────────────
  if (path === "/api/v1/campaigns") {
    if (method === "GET") {
      const page = parseListQuery(parseQuery(req.url));
      const { items, total } = await campaignRepository.list(tenantId, page);
      sendJson(res, 200, { items, total, limit: page.limit, offset: page.offset });
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
      if (payload.scheduledAt !== undefined && payload.scheduledAt !== null) {
        const scheduledTs = Date.parse(String(payload.scheduledAt));
        if (!Number.isFinite(scheduledTs)) {
          sendJson(res, 400, { error: "scheduledAt must be a valid ISO-8601 date string" });
          return;
        }
        if (scheduledTs <= Date.now()) {
          sendJson(res, 400, { error: "scheduledAt must be a future date" });
          return;
        }
      }
      const campaignCheck = validateCampaignBody(payload);
      if (!campaignCheck.ok) {
        sendJson(res, 400, { error: campaignCheck.error });
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
    const campaignId = extractPathSegment(path, "/api/v1/campaigns/");
    if (!campaignId || !UUID.test(campaignId)) {
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
    const campaignId = extractPathSegment(path, "/api/v1/campaigns/");
    if (!campaignId || !UUID.test(campaignId)) {
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
    const campaignId = extractPathSegment(path, "/api/v1/campaigns/");
    if (!campaignId || !UUID.test(campaignId)) {
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

  // Campaign recipients (paginated).
  if (/^\/api\/v1\/campaigns\/[^/]+\/recipients$/.test(path) && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "analyst"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const campaignId = path.split("/")[4];
    if (!campaignId || !UUID.test(campaignId)) {
      sendJson(res, 400, { error: "Invalid campaign id" });
      return;
    }
    const recipientsQuery = parseQuery(req.url);
    const offset = Number(recipientsQuery.get("offset") ?? "0");
    const limit = Math.min(Number(recipientsQuery.get("limit") ?? "100"), 500);
    const statusFilter = recipientsQuery.get("status") ?? undefined;
    const items = await campaignRecipientRepository.listByCampaign(tenantId, campaignId, {
      limit,
      status: statusFilter
    });
    sendJson(res, 200, { items, offset, limit });
    return;
  }

  // ─── Conversations ─────────────────────────────────────────────────────────
  if (path === "/api/v1/conversations" && method === "GET") {
    const query = parseQuery(req.url);
    const page = parseListQuery(query);
    const q = (query.get("q") ?? "").trim().slice(0, 200) || undefined;
    const { items, total } = await conversationRepository.list(tenantId, {
      state: query.get("state") ?? undefined,
      assignedUserId: query.get("assignee") ?? undefined,
      q,
      archived: query.get("archived") === "true",
      limit: page.limit,
      offset: page.offset
    });
    sendJson(res, 200, { items, total, limit: page.limit, offset: page.offset });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/assign") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ userId: string | null }>(req);
    await conversationRepository.assign(tenantId, conversationId, body.userId ?? null);
    sseHub.broadcast(tenantId, "conversation.assigned", randomUUID(), { conversationId, userId: body.userId });
    if (body.userId) {
      const conv = await conversationRepository.getById(tenantId, conversationId);
      await runAutomation(tenantId, "conversation_assigned", {}, { conversationId, contactId: conv?.contactId });
    }
    sendJson(res, 200, { status: "assigned", conversationId, userId: body.userId });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/assign-team") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ teamId: string | null }>(req);
    if (body.teamId && !UUID.test(body.teamId)) {
      sendJson(res, 400, { error: "teamId must be a valid id" });
      return;
    }
    if (body.teamId && !(await teamRepository.getById(tenantId, body.teamId))) {
      sendJson(res, 422, { error: "teamId does not belong to this tenant" });
      return;
    }
    await conversationRepository.assignTeam(tenantId, conversationId, body.teamId ?? null);
    sseHub.broadcast(tenantId, "conversation.team_assigned", randomUUID(), { conversationId, teamId: body.teamId });
    sendJson(res, 200, { status: "team_assigned", conversationId, teamId: body.teamId });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/state") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
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

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/archive") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ archived: boolean }>(req);
    if (typeof body.archived !== "boolean") {
      sendJson(res, 400, { error: "archived must be a boolean" });
      return;
    }
    await conversationRepository.setArchived(tenantId, conversationId, body.archived);
    sseHub.broadcast(tenantId, "conversation.archived", randomUUID(), { conversationId, archived: body.archived });
    sendJson(res, 200, { status: "archived", conversationId, archived: body.archived });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/pin") && method === "POST") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "support_agent", "sales_agent", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    const body = await readJsonBody<{ pinned: boolean }>(req);
    if (typeof body.pinned !== "boolean") {
      sendJson(res, 400, { error: "pinned must be a boolean" });
      return;
    }
    await conversationRepository.setPinned(tenantId, conversationId, body.pinned);
    sseHub.broadcast(tenantId, "conversation.pinned", randomUUID(), { conversationId, pinned: body.pinned });
    sendJson(res, 200, { status: "pinned", conversationId, pinned: body.pinned });
    return;
  }

  // Auth-only (no role gate): marking read is low-privilege and high-frequency,
  // same posture as GET .../messages. No audit entry — high-frequency, low-value.
  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/read") && method === "POST") {
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    await conversationRepository.markRead(tenantId, conversationId);
    sseHub.broadcast(tenantId, "conversation.read", randomUUID(), { conversationId });
    sendJson(res, 200, { status: "read", conversationId });
    return;
  }

  // ─── Conversation internal notes ──────────────────────────────────────────
  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/notes")) {
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, { items: await conversationNoteRepository.list(tenantId, conversationId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role to add an internal note" });
        return;
      }
      const body = await readJsonBody<{ note?: string }>(req);
      if (!body.note?.trim()) {
        sendJson(res, 400, { error: "note is required" });
        return;
      }
      const note = await conversationNoteRepository.add(tenantId, {
        conversationId,
        authorUserId: asActorUuid(auth.subject),
        note: body.note.trim()
      });
      await audit(tenantId, auth, {
        action: "conversation.note.added",
        resourceType: "Conversation",
        resourceId: conversationId,
        payload: { noteId: note.id }
      });
      sendJson(res, 201, { ...note });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Global message search: substring match over payload->>'text' via the
  // pg_trgm expression index from migration 020. Exact path — must match
  // the "/api/v1/messages/search" string classifyRoute lists as expensive
  // (rate-limit.ts EXPENSIVE_EXACT) so this route gets the tighter 10/min
  // budget instead of the general "read" class.
  if (path === "/api/v1/messages/search" && method === "GET") {
    const query = parseQuery(req.url);
    const rawQ = (query.get("q") ?? "").trim();
    if (rawQ.length < 2) {
      sendJson(res, 400, { error: "q must be at least 2 characters" });
      return;
    }
    const q = rawQ.slice(0, 200);
    const conversationId = query.get("conversationId") ?? undefined;
    if (conversationId && !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "conversationId must be a valid id" });
      return;
    }
    const page = parseListQuery(query);
    const { items, total } = await messageRepository.search(tenantId, {
      q,
      conversationId,
      limit: page.limit,
      offset: page.offset
    });
    sendJson(res, 200, { items, total, limit: page.limit, offset: page.offset });
    return;
  }

  if (path.startsWith("/api/v1/conversations/") && path.endsWith("/messages")) {
    const conversationId = extractPathSegment(path, "/api/v1/conversations/");
    if (!conversationId || !UUID.test(conversationId)) {
      sendJson(res, 400, { error: "Invalid conversation id" });
      return;
    }
    if (method === "GET") {
      const query = parseQuery(req.url);
      const items = await messageRepository.listByConversation(tenantId, conversationId, {
        limit: clampInt(query.get("limit"), 1, 200, 50),
        before: query.get("before") ?? undefined
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

  // ─── Media serving ────────────────────────────────────────────────────────
  if (path.startsWith("/api/v1/media/") && method === "GET") {
    const assetId = extractPathSegment(path, "/api/v1/media/");
    if (!assetId || !UUID.test(assetId)) {
      sendJson(res, 400, { error: "Invalid media id" });
      return;
    }
    const asset = await mediaRepository.getForServing(tenantId, assetId);
    if (!asset) {
      sendJson(res, 404, { error: "media_not_found" });
      return;
    }
    if (asset.status !== "stored") {
      sendJson(res, 409, { error: "media_not_ready", status: asset.status });
      return;
    }
    if (!asset.bytes) {
      // Data invariant violation: a `stored` row should always carry bytes.
      logger.error("media_stored_without_bytes", { tenantId, assetId });
      sendJson(res, 500, { error: "media_corrupt" });
      return;
    }
    const headers = buildMediaHeaders({
      mimeType: asset.mimeType,
      filename: asset.filename,
      byteLength: asset.bytes.length
    });
    res.statusCode = 200;
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    incCounter("media_served_total", "Media assets served via the authenticated media route.", {
      service: "api-gateway"
    });
    res.end(asset.bytes);
    return;
  }

  // ─── Auto-reply rules ─────────────────────────────────────────────────────
  if (path === "/api/v1/auto-reply-rules") {
    if (method === "GET") {
      sendJson(res, 200, { items: await autoReplyRuleRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role" });
        return;
      }
      const payload = await readJsonBody<CreateAutoReplyRuleRequest>(req);
      const matchType = payload.matchType ?? "keyword";
      if (!["keyword", "contains", "regex", "any"].includes(matchType)) {
        sendJson(res, 400, { error: "matchType must be keyword, contains, regex, or any" });
        return;
      }
      if (matchType !== "any") {
        const keywordCheck = boundedText(payload.keyword, 256);
        if (!keywordCheck.ok) {
          sendJson(res, 400, { error: `keyword ${keywordCheck.error} (required for matchType "${matchType}")` });
          return;
        }
        if (matchType === "regex") {
          try {
            new RegExp(keywordCheck.value);
          } catch {
            sendJson(res, 400, { error: "keyword is not a valid regular expression" });
            return;
          }
        }
      }
      const replyTextCheck = boundedText(payload.replyText, 4096);
      if (!replyTextCheck.ok) {
        sendJson(res, 400, { error: `replyText ${replyTextCheck.error}` });
        return;
      }
      const enabledRaw = payload.enabled;
      if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
        sendJson(res, 400, { error: "enabled must be a boolean" });
        return;
      }
      const rule = await autoReplyRuleRepository.create(tenantId, {
        matchType,
        keyword: matchType !== "any" ? payload.keyword : undefined,
        replyKind: "text",
        replyText: replyTextCheck.value,
        enabled: enabledRaw ?? true,
        priority: clampInt(payload.priority, 0, 1000, 0)
      });
      sendJson(res, 201, { ...rule });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/auto-reply-rules/") && method === "PATCH") {
    const ruleId = extractPathSegment(path, "/api/v1/auto-reply-rules/");
    if (!ruleId || !UUID.test(ruleId)) {
      sendJson(res, 400, { error: "Invalid rule id" });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "support_agent"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const body = await readJsonBody<{ enabled: boolean }>(req);
    if (typeof body.enabled !== "boolean") {
      sendJson(res, 400, { error: "enabled must be a boolean" });
      return;
    }
    await autoReplyRuleRepository.setEnabled(tenantId, ruleId, body.enabled);
    sendJson(res, 200, { status: "updated", ruleId, enabled: body.enabled });
    return;
  }

  // ─── Saved replies ────────────────────────────────────────────────────────
  if (path === "/api/v1/saved-replies") {
    if (method === "GET") {
      sendJson(res, 200, { items: await savedReplyRepository.list(tenantId) });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role" });
        return;
      }
      const body = await readJsonBody<{ title?: string; body?: string }>(req);
      const titleCheck = boundedText(body.title, 120);
      const bodyCheck = boundedText(body.body, 4096);
      if (!titleCheck.ok || !bodyCheck.ok) {
        sendJson(res, 400, { error: "title and body are required" });
        return;
      }
      const reply = await savedReplyRepository.create(tenantId, { title: titleCheck.value, body: bodyCheck.value });
      sendJson(res, 201, { ...reply });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/saved-replies/") && method === "DELETE") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const replyId = extractPathSegment(path, "/api/v1/saved-replies/");
    if (!replyId || !UUID.test(replyId)) {
      sendJson(res, 400, { error: "Invalid saved reply id" });
      return;
    }
    await savedReplyRepository.delete(tenantId, replyId);
    sendJson(res, 200, { status: "deleted", replyId });
    return;
  }

  // ─── Automation rules ─────────────────────────────────────────────────────
  if (path === "/api/v1/automation-rules") {
    if (method === "GET") {
      const page = parseListQuery(parseQuery(req.url));
      const { items, total } = await automationRuleRepository.list(tenantId, page);
      sendJson(res, 200, { items, total, limit: page.limit, offset: page.offset });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
        sendJson(res, 403, { error: "Insufficient role" });
        return;
      }
      const payload = await readJsonBody<CreateAutomationRuleRequest>(req);
      if (!payload.name?.trim() || !payload.triggerType || !payload.actionType) {
        sendJson(res, 400, { error: "name, triggerType and actionType are required" });
        return;
      }
      const nameCheck = boundedText(payload.name, 256);
      if (!nameCheck.ok) {
        sendJson(res, 400, { error: `name ${nameCheck.error}` });
        return;
      }
      if (!AUTOMATION_TRIGGERS.has(payload.triggerType) || !AUTOMATION_ACTIONS.has(payload.actionType)) {
        sendJson(res, 400, { error: "Unknown triggerType or actionType" });
        return;
      }
      const assignee = payload.actionConfig?.assigneeUserId;
      if (payload.actionType === "assign_agent") {
        if (!assignee || !UUID.test(assignee)) {
          sendJson(res, 400, { error: "actionConfig.assigneeUserId must be a valid user id for assign_agent" });
          return;
        }
        if (!(await userRepository.getById(tenantId, assignee))) {
          sendJson(res, 422, { error: "actionConfig.assigneeUserId does not belong to this tenant" });
          return;
        }
      }
      const enabledRaw = payload.enabled;
      if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
        sendJson(res, 400, { error: "enabled must be a boolean" });
        return;
      }
      const rule = await automationRuleRepository.create(tenantId, {
        name: nameCheck.value,
        triggerType: payload.triggerType,
        conditions: payload.conditions,
        actionType: payload.actionType,
        actionConfig: payload.actionConfig,
        enabled: enabledRaw ?? true,
        priority: clampInt(payload.priority, 0, 1000, 0)
      });
      await audit(tenantId, auth, {
        action: "automation.rule.created",
        resourceType: "AutomationRule",
        resourceId: rule.id,
        payload: { triggerType: rule.triggerType, actionType: rule.actionType }
      });
      sendJson(res, 201, { ...rule });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/automation-rules/") && method === "PATCH") {
    const ruleId = extractPathSegment(path, "/api/v1/automation-rules/");
    if (!ruleId || !UUID.test(ruleId)) {
      sendJson(res, 400, { error: "Invalid rule id" });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const body = await readJsonBody<{ enabled: boolean }>(req);
    if (typeof body.enabled !== "boolean") {
      sendJson(res, 400, { error: "enabled must be a boolean" });
      return;
    }
    await automationRuleRepository.setEnabled(tenantId, ruleId, body.enabled);
    sendJson(res, 200, { status: "updated", ruleId, enabled: body.enabled });
    return;
  }

  // ─── Tasks / reminders ────────────────────────────────────────────────────
  if (path === "/api/v1/tasks") {
    if (method === "GET") {
      const q = parseQuery(req.url);
      const page = parseListQuery(q);
      const { items, total } = await taskRepository.list(tenantId, {
        status: q.get("status") ?? undefined,
        assigneeUserId: q.get("assignee") ?? undefined,
        limit: page.limit,
        offset: page.offset
      });
      sendJson(res, 200, { items, total, limit: page.limit, offset: page.offset });
      return;
    }
    if (method === "POST") {
      if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
        sendJson(res, 403, { error: "Insufficient role to create tasks" });
        return;
      }
      const payload = await readJsonBody<CreateTaskRequest>(req);
      const titleCheck = boundedText(payload.title, 256);
      if (!titleCheck.ok) {
        sendJson(res, 400, { error: `title ${titleCheck.error}` });
        return;
      }
      for (const [field, value] of [
        ["contactId", payload.contactId],
        ["conversationId", payload.conversationId],
        ["assigneeUserId", payload.assigneeUserId]
      ] as const) {
        if (value !== undefined && !UUID.test(value)) {
          sendJson(res, 400, { error: `${field} must be a valid id` });
          return;
        }
      }
      if (payload.assigneeUserId && !(await userRepository.getById(tenantId, payload.assigneeUserId))) {
        sendJson(res, 422, { error: "assigneeUserId does not belong to this tenant" });
        return;
      }
      const dueCheck = parseOptionalIsoDate(payload.dueAt);
      const remindCheck = parseOptionalIsoDate(payload.remindAt);
      if (!dueCheck.ok || !remindCheck.ok) {
        sendJson(res, 400, { error: "dueAt/remindAt must be valid ISO-8601 dates" });
        return;
      }
      const task = await taskRepository.create(tenantId, {
        title: titleCheck.value,
        contactId: payload.contactId,
        conversationId: payload.conversationId,
        assigneeUserId: payload.assigneeUserId,
        dueAt: dueCheck.value,
        remindAt: remindCheck.value ?? dueCheck.value
      });
      await audit(tenantId, auth, {
        action: "task.created",
        resourceType: "Task",
        resourceId: task.id,
        payload: { title: task.title }
      });
      sendJson(res, 201, { ...task });
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/tasks/") && method === "PATCH") {
    const taskId = extractPathSegment(path, "/api/v1/tasks/");
    if (!taskId || !UUID.test(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const body = await readJsonBody<{ status: "open" | "done" | "cancelled" }>(req);
    if (!["open", "done", "cancelled"].includes(body.status)) {
      sendJson(res, 400, { error: "status must be open, done, or cancelled" });
      return;
    }
    await taskRepository.updateStatus(tenantId, taskId, body.status);
    sendJson(res, 200, { status: "updated", taskId, taskStatus: body.status });
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
      if (!UUID.test(payload.contactId)) {
        sendJson(res, 400, { error: "contactId must be a valid id" });
        return;
      }
      if (
        typeof payload.amountMinor !== "number" ||
        !Number.isInteger(payload.amountMinor) ||
        payload.amountMinor <= 0
      ) {
        sendJson(res, 400, { error: "amountMinor must be a positive integer (amount in minor currency units)" });
        return;
      }
      if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) {
        sendJson(res, 400, { error: "currency must be a 3-letter ISO 4217 currency code" });
        return;
      }
      const externalOrderIdCheck = boundedText(payload.externalOrderId, 256);
      if (!externalOrderIdCheck.ok) {
        sendJson(res, 400, { error: `externalOrderId ${externalOrderIdCheck.error}` });
        return;
      }
      const order = await orderRepository.create(tenantId, { ...payload, externalOrderId: externalOrderIdCheck.value });
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
  if (path === "/api/v1/analytics/link-clicks" && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "marketing_manager", "analyst"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const lcQuery = parseQuery(req.url);
    const lcCampaignId = lcQuery.get("campaignId") ?? undefined;
    const lcOffset = Number(lcQuery.get("offset") ?? "0");
    const lcLimit = Math.min(Number(lcQuery.get("limit") ?? "100"), 500);
    const result = await linkClickRepository.list(tenantId, {
      campaignId: lcCampaignId,
      offset: lcOffset,
      limit: lcLimit
    });
    sendJson(res, 200, result);
    return;
  }

  if (path === "/api/v1/analytics" && method === "GET") {
    const analyticsCampaignId = parseQuery(req.url).get("campaignId") ?? undefined;
    const totals = await tenantAnalytics(tenantId, { campaignId: analyticsCampaignId });
    sendJson(res, 200, { tenantId, totals });
    return;
  }

  if (path === "/api/v1/audit" && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin", "compliance_auditor"])) {
      sendJson(res, 403, { error: "Insufficient role to read audit log" });
      return;
    }
    const auditQuery = parseQuery(req.url);
    const auditPage = parseListQuery(auditQuery, 50, 200);
    const items = await auditRepository.list(tenantId, auditPage);
    sendJson(res, 200, { items, limit: auditPage.limit, offset: auditPage.offset });
    return;
  }

  // ─── Outbox dead-letters (admin) ──────────────────────────────────────────
  if (path === "/api/v1/admin/dead-letters" && method === "GET") {
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const dlQuery = parseQuery(req.url);
    const limit = clampInt(dlQuery.get("limit"), 1, 200, 50);
    const items = await outboxRepository.listDead(tenantId, limit);
    sendJson(res, 200, { items });
    return;
  }

  if (path.startsWith("/api/v1/admin/dead-letters/") && path.endsWith("/replay") && method === "POST") {
    const deadLetterId = extractPathSegment(path, "/api/v1/admin/dead-letters/");
    if (!deadLetterId || !UUID.test(deadLetterId)) {
      sendJson(res, 400, { error: "Invalid dead letter id" });
      return;
    }
    if (!hasAnyRole(auth, ["platform_owner", "tenant_admin"])) {
      sendJson(res, 403, { error: "Insufficient role" });
      return;
    }
    const replayed = await outboxRepository.replayDead(tenantId, deadLetterId);
    if (!replayed) {
      sendJson(res, 404, { error: "dead_letter_not_found" });
      return;
    }
    incCounter("outbox_events_replayed_total", "Dead-lettered outbox events manually replayed.");
    await audit(tenantId, auth, {
      action: "outbox.dead_letter.replayed",
      resourceType: "OutboxEvent",
      resourceId: deadLetterId,
      payload: { status: "replayed" }
    });
    sendJson(res, 200, { status: "replayed", id: deadLetterId });
    return;
  }

  // ─── Reporting service proxy ──────────────────────────────────────────────
  if (path === "/api/v1/reports/overview" && method === "GET") {
    const { status, body } = await reportsOverviewProxy({ tenantId, requestId: ctx.requestId });
    sendJson(res, status, body);
    return;
  }

  // ─── Billing / usage proxy ────────────────────────────────────────────────
  if (path === "/api/v1/usage" && method === "GET") {
    const days = parseQuery(req.url).get("days") ?? "7";
    const { status, body } = await usageProxy({ tenantId, requestId: ctx.requestId }, days);
    sendJson(res, status, body);
    return;
  }

  // ─── AI intelligence proxy ────────────────────────────────────────────────
  if (path.startsWith("/api/v1/ai/") && (method === "POST" || method === "GET")) {
    const aiPath = path.slice("/api/v1/ai/".length);
    const ALLOWED_AI_PATHS = ["campaign-draft", "segment-summary", "lead-score"] as const;
    if (!ALLOWED_AI_PATHS.includes(aiPath as (typeof ALLOWED_AI_PATHS)[number])) {
      sendJson(res, 404, { error: "route_not_found" });
      return;
    }
    const raw = method === "POST" ? await readRawBody(req) : undefined;
    const { status, body } = await aiProxy({ tenantId, requestId: ctx.requestId }, aiPath, method, raw);
    sendJson(res, status, body);
    return;
  }

  sendJson(res, 404, { error: "route_not_found", method, path, requestId: ctx.requestId });
}

// ─── Modular-monolith mount point ───────────────────────────────────────────

export interface GatewayDeps {
  /**
   * Shared in-process event bus. When provided (by app-server) the gateway
   * publishes/consumes on it so worker consumers see gateway-published events;
   * when omitted the gateway uses its own bus (standalone service).
   */
  eventBus?: EventBus;
  /**
   * Direct in-process webhook ingestion. When provided the gateway calls it
   * instead of proxying to the webhook-ingestor over HTTP (Phase 3).
   */
  proxyWebhookToIngestor?: IngestWebhookProxy;
  /** Direct in-process reports/overview (Phase 8). */
  proxyReportsOverview?: ReportsOverviewProxy;
  /** Direct in-process usage (Phase 7). */
  proxyUsage?: UsageProxy;
  /** Direct in-process AI intelligence (Phase 6). */
  proxyAi?: AiProxy;
}

export interface GatewayModule {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  applySecurityHeaders: (res: ServerResponse) => void;
  startSchedulers: () => NodeJS.Timeout[];
  bootstrapPlatformAdmin: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Composition seam for the modular monolith. Injects the shared event bus (if
 * given), registers SSE forwarding on it, and returns the request handler plus
 * lifecycle hooks. All request/scheduler logic above is unchanged — this only
 * wires it into a host process (standalone service or app-server).
 */
export function createGatewayHandler(deps: GatewayDeps = {}): GatewayModule {
  if (deps.eventBus) {
    eventBus = deps.eventBus;
  }
  if (deps.proxyWebhookToIngestor) {
    ingestWebhookProxy = deps.proxyWebhookToIngestor;
  }
  if (deps.proxyReportsOverview) {
    reportsOverviewProxy = deps.proxyReportsOverview;
  }
  if (deps.proxyUsage) {
    usageProxy = deps.proxyUsage;
  }
  if (deps.proxyAi) {
    aiProxy = deps.proxyAi;
  }
  registerSseForwarding();
  return {
    handle,
    applySecurityHeaders,
    startSchedulers: () => [
      startOutboxRelay(),
      startCampaignScheduler(),
      startNoReplyScheduler(),
      startReminderScheduler(),
      startSessionPurgeScheduler()
    ],
    bootstrapPlatformAdmin,
    close: async () => {
      await eventBus.close().catch(() => undefined);
    }
  };
}

// ─── Standalone entrypoint ──────────────────────────────────────────────────

async function startStandalone(): Promise<void> {
  const gateway = createGatewayHandler();

  const server = createServer((req, res) => {
    gateway.applySecurityHeaders(res);
    gateway.handle(req, res).catch((error) => {
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

  const schedulerTimers = gateway.startSchedulers();

  await gateway.bootstrapPlatformAdmin();

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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutdown_started", { signal });
    for (const timer of schedulerTimers) {
      clearInterval(timer);
    }
    sseHub.close();
    server.close(async () => {
      await gateway.close();
      await closePool().catch(() => undefined);
      logger.info("shutdown_complete", { signal });
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Boot the standalone HTTP service only when executed directly, never when
// imported by app-server or tests.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void startStandalone();
}
