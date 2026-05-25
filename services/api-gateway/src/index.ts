import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import { loadConfig } from "@hyfib/config";
import {
  IdempotencyStore,
  Logger,
  parseQuery,
  parseUrlPath,
  readJsonBody,
  readRawBody,
  requestContext,
  sendJson,
  verifyMetaSignature,
  type AuditEvent,
  type Campaign,
  type Contact,
  type Role,
  type Template,
  type Tenant,
  type User,
  type WhatsAppChannel
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
  templateName: string;
  templateLanguage: string;
  templateCategory: "marketing" | "utility" | "authentication" | "service";
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

const webhookIdempotency = new IdempotencyStore(24 * 60 * 60 * 1000);

const tenants = new Map<string, Tenant>();
const users = new Map<string, User>();
const channels = new Map<string, WhatsAppChannel>();
const templates = new Map<string, Template>();
const campaigns = new Map<string, Campaign & { templateName: string; templateLanguage: string }>();
const contacts = new Map<string, Contact>();
const orders = new Map<string, Record<string, unknown>>();
const auditEvents: AuditEvent[] = [];

function requireRole(rawRoleHeader: string | string[] | undefined, allowed: Role[]): { allowed: boolean; role?: Role } {
  const role = typeof rawRoleHeader === "string" ? (rawRoleHeader as Role) : undefined;
  if (!role || !allowed.includes(role)) {
    return { allowed: false };
  }
  return { allowed: true, role };
}

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function addAudit(event: Omit<AuditEvent, "id" | "createdAt">): void {
  auditEvents.push({
    ...event,
    id: generateId("audit"),
    createdAt: new Date().toISOString()
  });
}

function tenantRecords<T extends { tenantId: string }>(map: Map<string, T>, tenantId: string): T[] {
  return [...map.values()].filter((item) => item.tenantId === tenantId);
}

async function forwardWebhook(rawBody: string, signature: string, tenantId?: string): Promise<Response> {
  return fetch(`${config.webhookIngestorUrl}/internal/v1/webhooks/meta/whatsapp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-request-id": randomUUID()
    },
    body: JSON.stringify({
      rawBody,
      signature,
      tenantId
    })
  });
}

async function dispatchCampaign(
  tenantId: string,
  campaignId: string,
  payload: DispatchCampaignRequest,
  template: Template,
  campaign: Campaign & { templateName: string; templateLanguage: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const policy = evaluateOutboundPolicy({
    hasActiveConsent: payload.hasActiveConsent,
    isInside24hWindow: payload.isInside24hWindow,
    template,
    requestedCategory: campaign.templateCategory,
    isOptedOut: payload.isOptedOut,
    currentHourLocal: payload.currentHourLocal,
    quietHours: payload.quietHours,
    frequencyCap: payload.frequencyCap
  });

  if (!policy.allowed) {
    return {
      status: 422,
      body: {
        error: "campaign_blocked_by_policy",
        reason: policy.reason
      }
    };
  }

  const selectedChannel = tenantRecords(channels, tenantId)[0];
  if (!selectedChannel) {
    return {
      status: 409,
      body: {
        error: "No WhatsApp channel configured for tenant"
      }
    };
  }

  const campaignDispatchResponse = await fetch(`${config.campaignServicePort ? "http://campaign-service:" + config.campaignServicePort : "http://campaign-service:8086"}/internal/v1/campaigns/${campaignId}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-request-id": randomUUID()
    },
    body: JSON.stringify({
      channelId: selectedChannel.id,
      contactPhoneE164: payload.contactPhoneE164,
      parameters: payload.parameters ?? [],
      hasActiveConsent: payload.hasActiveConsent,
      isOptedOut: payload.isOptedOut,
      isInside24hWindow: payload.isInside24hWindow,
      currentHourLocal: payload.currentHourLocal,
      quietHours: payload.quietHours,
      frequencyCap: payload.frequencyCap
    })
  });

  const campaignDispatchBody = (await campaignDispatchResponse.json()) as Record<string, unknown>;

  if (!campaignDispatchResponse.ok) {
    return {
      status: campaignDispatchResponse.status,
      body: {
        error: "campaign_service_rejected",
        details: campaignDispatchBody
      }
    };
  }

  const workerResponse = await fetch(`${config.notificationWorkerPort ? "http://notification-worker:" + config.notificationWorkerPort : "http://notification-worker:8094"}/internal/v1/dispatch/campaign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-request-id": randomUUID()
    },
    body: JSON.stringify({
      campaignId,
      tenantId,
      channelId: selectedChannel.id,
      templateName: campaign.templateName,
      templateLanguage: campaign.templateLanguage,
      templateCategory: campaign.templateCategory,
      contactPhoneE164: payload.contactPhoneE164,
      parameters: payload.parameters ?? []
    })
  });

  const workerBody = (await workerResponse.json()) as Record<string, unknown>;

  return {
    status: workerResponse.status,
    body: {
      status: "dispatch_triggered",
      campaign: campaignDispatchBody,
      notification: workerBody
    }
  };
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const path = parseUrlPath(req.url);
  const ctx = requestContext(req);
  const roleCheck = requireRole(req.headers["x-role"], [
    "platform_owner",
    "tenant_admin",
    "marketing_manager",
    "sales_agent",
    "support_agent",
    "analyst",
    "compliance_auditor"
  ]);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "api-gateway",
      status: "ok",
      timestamp: new Date().toISOString(),
      tenants: tenants.size,
      users: users.size
    });
    return;
  }

  if (path === "/api/v1/webhooks/meta/whatsapp" && method === "GET") {
    const query = parseQuery(req.url);
    const mode = query.get("hub.mode");
    const token = query.get("hub.verify_token");
    const challenge = query.get("hub.challenge");

    if (mode === "subscribe" && token === config.webhookVerifyToken && challenge) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(challenge);
      return;
    }

    sendJson(res, 403, {
      error: "Webhook verification failed"
    });
    return;
  }

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

    const idempotencyKey = `webhook:${normalizedSignature}`;
    if (webhookIdempotency.isDuplicate(idempotencyKey)) {
      sendJson(res, 200, {
        status: "duplicate_ignored"
      });
      return;
    }

    const proxyResponse = await forwardWebhook(rawBody, normalizedSignature);
    const proxyBody = (await proxyResponse.json()) as Record<string, unknown>;

    sendJson(res, proxyResponse.ok ? 200 : 502, {
      requestId: ctx.requestId,
      upstream: proxyBody
    });
    return;
  }

  if (path.startsWith("/api/v1/") && !roleCheck.allowed) {
    sendJson(res, 403, {
      error: "Missing or unauthorized x-role"
    });
    return;
  }

  if (path === "/api/v1/tenants") {
    if (method === "GET") {
      sendJson(res, 200, { items: [...tenants.values()] });
      return;
    }

    if (method === "POST") {
      const createCheck = requireRole(req.headers["x-role"], ["platform_owner"]);
      if (!createCheck.allowed) {
        sendJson(res, 403, { error: "Only platform_owner can create tenants" });
        return;
      }

      const payload = await readJsonBody<CreateTenantRequest>(req);
      if (!payload.name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }

      const tenant: Tenant = {
        id: generateId("tenant"),
        name: payload.name,
        status: "active",
        createdAt: new Date().toISOString()
      };

      tenants.set(tenant.id, tenant);
      addAudit({
        tenantId: tenant.id,
        actorId: ctx.actorId,
        action: "tenant.created",
        resourceType: "Tenant",
        resourceId: tenant.id,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, tenant as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/users") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, { items: tenantRecords(users, tenantId) });
      return;
    }

    if (method === "POST") {
      const createCheck = requireRole(req.headers["x-role"], ["platform_owner", "tenant_admin"]);
      if (!createCheck.allowed) {
        sendJson(res, 403, { error: "Only platform_owner/tenant_admin can create users" });
        return;
      }

      const payload = await readJsonBody<CreateUserRequest>(req);
      if (!payload.email || !payload.displayName || !payload.roles?.length) {
        sendJson(res, 400, { error: "email, displayName, and roles are required" });
        return;
      }

      const user: User = {
        id: generateId("user"),
        tenantId,
        email: payload.email,
        displayName: payload.displayName,
        roles: payload.roles,
        status: "active"
      };

      users.set(user.id, user);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "user.created",
        resourceType: "User",
        resourceId: user.id,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, user as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/channels/whatsapp") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, { items: tenantRecords(channels, tenantId) });
      return;
    }

    if (method === "POST") {
      const payload = await readJsonBody<CreateChannelRequest>(req);
      if (!payload.wabaId || !payload.phoneNumberId || !payload.displayPhoneNumber) {
        sendJson(res, 400, { error: "wabaId, phoneNumberId, displayPhoneNumber are required" });
        return;
      }

      const channel: WhatsAppChannel = {
        id: generateId("wa_channel"),
        tenantId,
        wabaId: payload.wabaId,
        phoneNumberId: payload.phoneNumberId,
        displayPhoneNumber: payload.displayPhoneNumber,
        qualityRating: "unknown",
        status: "active",
        createdAt: new Date().toISOString()
      };

      channels.set(channel.id, channel);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "channel.whatsapp.created",
        resourceType: "WhatsAppChannel",
        resourceId: channel.id,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, channel as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/templates") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, { items: tenantRecords(templates, tenantId) });
      return;
    }

    if (method === "POST") {
      const payload = await readJsonBody<CreateTemplateRequest>(req);
      if (!payload.name || !payload.category || !payload.language || !payload.body) {
        sendJson(res, 400, { error: "name, category, language, body are required" });
        return;
      }

      const template: Template = {
        id: generateId("template"),
        tenantId,
        name: payload.name,
        category: payload.category,
        language: payload.language,
        status: "approved",
        body: payload.body
      };

      templates.set(template.id, template);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "template.created",
        resourceType: "Template",
        resourceId: template.id,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, template as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/campaigns") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, { items: tenantRecords(campaigns, tenantId) });
      return;
    }

    if (method === "POST") {
      const payload = await readJsonBody<CreateCampaignRequest>(req);
      if (!payload.name || !payload.templateId || !payload.templateName || !payload.templateLanguage) {
        sendJson(res, 400, { error: "name, templateId, templateName, templateLanguage are required" });
        return;
      }

      if (payload.templateCategory !== "marketing") {
        sendJson(res, 422, {
          error: "Only marketing template category is allowed in this endpoint"
        });
        return;
      }

      const id = generateId("campaign");
      const campaign: Campaign & { templateName: string; templateLanguage: string } = {
        id,
        tenantId,
        name: payload.name,
        templateId: payload.templateId,
        templateCategory: payload.templateCategory,
        status: "draft",
        createdAt: new Date().toISOString(),
        templateName: payload.templateName,
        templateLanguage: payload.templateLanguage
      };

      campaigns.set(id, campaign);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "campaign.created",
        resourceType: "Campaign",
        resourceId: campaign.id,
        payload: payload as unknown as Record<string, unknown>
      });

      await fetch(`http://campaign-service:${config.campaignServicePort}/internal/v1/campaigns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          "x-request-id": randomUUID()
        },
        body: JSON.stringify(payload)
      }).catch((error: unknown) => {
        logger.warn("campaign_service_seed_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });

      sendJson(res, 201, campaign as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path.startsWith("/api/v1/campaigns/") && path.endsWith("/dispatch") && method === "POST") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    const campaignId = path.replace("/api/v1/campaigns/", "").replace("/dispatch", "").trim();
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.tenantId !== tenantId) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }

    const template = templates.get(campaign.templateId);
    if (!template) {
      sendJson(res, 409, { error: "Template not found" });
      return;
    }

    const payload = await readJsonBody<DispatchCampaignRequest>(req);
    const result = await dispatchCampaign(tenantId, campaignId, payload, template, campaign);

    addAudit({
      tenantId,
      actorId: ctx.actorId,
      action: "campaign.dispatch.requested",
      resourceType: "Campaign",
      resourceId: campaignId,
      payload: {
        contactPhoneE164: payload.contactPhoneE164,
        parametersCount: payload.parameters?.length ?? 0
      }
    });

    sendJson(res, result.status, result.body);
    return;
  }

  if (path === "/api/v1/contacts") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, { items: tenantRecords(contacts, tenantId) });
      return;
    }

    if (method === "POST") {
      const payload = await readJsonBody<CreateContactRequest>(req);
      if (!payload.phoneE164) {
        sendJson(res, 400, { error: "phoneE164 is required" });
        return;
      }

      const contact: Contact = {
        id: generateId("contact"),
        tenantId,
        phoneE164: payload.phoneE164,
        firstName: payload.firstName,
        lastName: payload.lastName,
        optedOut: false,
        country: payload.country,
        tags: payload.tags ?? []
      };

      contacts.set(contact.id, contact);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "contact.created",
        resourceType: "Contact",
        resourceId: contact.id,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, contact as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/conversations" && method === "GET") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    sendJson(res, 200, {
      items: tenantRecords(contacts, tenantId).map((contact) => ({
        id: generateId("conv"),
        tenantId,
        contactId: contact.id,
        channelId: tenantRecords(channels, tenantId)[0]?.id,
        lastMessageAt: undefined
      }))
    });
    return;
  }

  if (path === "/api/v1/orders") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, {
        items: [...orders.values()].filter((item) => item.tenantId === tenantId)
      });
      return;
    }

    if (method === "POST") {
      const payload = await readJsonBody<CreateOrderRequest>(req);
      if (!payload.contactId || !payload.externalOrderId || !payload.amountMinor || !payload.currency) {
        sendJson(res, 400, { error: "contactId, externalOrderId, amountMinor and currency are required" });
        return;
      }

      const orderId = generateId("order");
      const order = {
        id: orderId,
        tenantId,
        contactId: payload.contactId,
        externalOrderId: payload.externalOrderId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        status: "created",
        createdAt: new Date().toISOString()
      };

      orders.set(orderId, order);
      addAudit({
        tenantId,
        actorId: ctx.actorId,
        action: "order.created",
        resourceType: "Order",
        resourceId: orderId,
        payload: payload as unknown as Record<string, unknown>
      });

      sendJson(res, 201, order as unknown as Record<string, unknown>);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/v1/analytics" && method === "GET") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    const tenantTemplates = tenantRecords(templates, tenantId);
    const tenantCampaigns = tenantRecords(campaigns, tenantId);
    const tenantContacts = tenantRecords(contacts, tenantId);
    const optOutCount = tenantContacts.filter((x) => x.optedOut).length;

    sendJson(res, 200, {
      tenantId,
      totals: {
        templates: tenantTemplates.length,
        campaigns: tenantCampaigns.length,
        contacts: tenantContacts.length,
        optOutRate: tenantContacts.length ? Number((optOutCount / tenantContacts.length).toFixed(4)) : 0
      }
    });
    return;
  }

  if (path === "/api/v1/audit" && method === "GET") {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id" });
      return;
    }

    sendJson(res, 200, {
      items: auditEvents.filter((event) => event.tenantId === tenantId)
    });
    return;
  }

  sendJson(res, 404, {
    error: "route_not_found",
    method,
    path,
    requestId: ctx.requestId
  });
});

server.listen(config.apiGatewayPort, () => {
  logger.info("service_started", {
    port: config.apiGatewayPort,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
