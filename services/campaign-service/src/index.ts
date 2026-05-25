import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { RabbitMqEventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import {
  EventTopics,
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readJsonBody,
  requestContext,
  sendJson,
  type Campaign,
  type CampaignDispatchRequest,
  type Template
} from "@hyfib/shared-core";

interface CreateCampaignRequest {
  name: string;
  templateId: string;
  templateName: string;
  templateLanguage: string;
  templateCategory: "marketing" | "utility" | "authentication" | "service";
}

interface DispatchCampaignRequest {
  channelId: string;
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

const config = loadConfig();
const logger = new Logger("campaign-service", config.logLevel as "debug" | "info" | "warn" | "error");
const eventBus = new RabbitMqEventBus();

const campaigns = new Map<string, Campaign & { templateName: string; templateLanguage: string }>();
const templates = new Map<string, Template>();

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const path = parseUrlPath(req.url);
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "campaign-service",
      status: "ok",
      campaigns: campaigns.size,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/internal/v1/campaigns") {
    if (method === "GET") {
      sendJson(res, 200, {
        items: [...campaigns.values()]
      });
      return;
    }

    if (method === "POST") {
      if (!ctx.tenantId) {
        sendJson(res, 400, { error: "Missing x-tenant-id header" });
        return;
      }

      const payload = await readJsonBody<CreateCampaignRequest>(req);
      if (!payload.name || !payload.templateId || !payload.templateName || !payload.templateLanguage) {
        sendJson(res, 400, { error: "name, templateId, templateName, and templateLanguage are required" });
        return;
      }

      const id = randomUUID();
      const campaign: Campaign & { templateName: string; templateLanguage: string } = {
        id,
        tenantId: ctx.tenantId,
        name: payload.name,
        templateId: payload.templateId,
        templateCategory: payload.templateCategory,
        status: "draft",
        createdAt: new Date().toISOString(),
        templateName: payload.templateName,
        templateLanguage: payload.templateLanguage
      };

      campaigns.set(id, campaign);
      templates.set(payload.templateId, {
        id: payload.templateId,
        tenantId: ctx.tenantId,
        name: payload.templateName,
        category: payload.templateCategory,
        status: "approved",
        language: payload.templateLanguage,
        body: ""
      });

      sendJson(res, 201, campaign as unknown as Record<string, unknown>);
      return;
    }

    methodNotAllowed(res);
    return;
  }

  if (path.startsWith("/internal/v1/campaigns/") && path.endsWith("/dispatch")) {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    if (!ctx.tenantId) {
      sendJson(res, 400, { error: "Missing x-tenant-id header" });
      return;
    }

    const campaignId = path.replace("/internal/v1/campaigns/", "").replace("/dispatch", "").trim();
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.tenantId !== ctx.tenantId) {
      sendJson(res, 404, { error: "Campaign not found" });
      return;
    }

    const template = templates.get(campaign.templateId);
    if (!template) {
      sendJson(res, 409, { error: "Template not available for campaign" });
      return;
    }

    const payload = await readJsonBody<DispatchCampaignRequest>(req);
    if (!payload.channelId || !payload.contactPhoneE164) {
      sendJson(res, 400, { error: "channelId and contactPhoneE164 are required" });
      return;
    }

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
      sendJson(res, 422, {
        error: "campaign_blocked_by_policy",
        reason: policy.reason
      });
      return;
    }

    const command: CampaignDispatchRequest = {
      campaignId,
      tenantId: ctx.tenantId,
      channelId: payload.channelId,
      templateName: campaign.templateName,
      templateLanguage: campaign.templateLanguage,
      templateCategory: campaign.templateCategory,
      contactPhoneE164: payload.contactPhoneE164,
      parameters: payload.parameters ?? []
    };

    await eventBus.publish(EventTopics.CampaignDispatchRequested, command, ctx.tenantId);

    campaigns.set(campaign.id, {
      ...campaign,
      status: "running"
    });

    logger.info("campaign_dispatch_requested", {
      campaignId,
      tenantId: ctx.tenantId,
      requestId: ctx.requestId
    });

    sendJson(res, 202, {
      status: "accepted",
      campaignId,
      requestId: ctx.requestId
    });
    return;
  }

  notFound(res);
});

server.listen(config.campaignServicePort, () => {
  logger.info("service_started", {
    port: config.campaignServicePort,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
