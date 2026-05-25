import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "@hyfib/config";
import {
  IdempotencyStore,
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readJsonBody,
  requestContext,
  sendJson,
  type CampaignDispatchRequest,
  type CampaignDispatchResult
} from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("notification-worker", config.logLevel as "debug" | "info" | "warn" | "error");
const idempotency = new IdempotencyStore(24 * 60 * 60 * 1000);

async function sendTemplate(command: CampaignDispatchRequest): Promise<CampaignDispatchResult> {
  const response = await fetch(`${config.metaAdapterUrl}/internal/v1/whatsapp/send-template`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": command.tenantId,
      "x-request-id": randomUUID()
    },
    body: JSON.stringify({
      phoneNumberId: config.whatsappPhoneNumberId,
      to: command.contactPhoneE164,
      templateName: command.templateName,
      templateLanguage: command.templateLanguage,
      parameters: command.parameters
    })
  });

  const body = (await response.json()) as {
    result?: {
      messageId?: string;
      status?: string;
      error?: string;
    };
    error?: string;
  };

  if (!response.ok) {
    return {
      campaignId: command.campaignId,
      tenantId: command.tenantId,
      status: "failed",
      error: body.error ?? "meta_adapter_rejected"
    };
  }

  return {
    campaignId: command.campaignId,
    tenantId: command.tenantId,
    status: body.result?.status === "accepted" ? "sent" : "queued",
    externalMessageId: body.result?.messageId,
    error: body.result?.error
  };
}

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/health") {
    sendJson(res, 200, {
      service: "notification-worker",
      status: "ok",
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (path === "/internal/v1/dispatch/campaign") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const command = await readJsonBody<CampaignDispatchRequest>(req);
    if (!command.campaignId || !command.tenantId || !command.templateName || !command.contactPhoneE164) {
      sendJson(res, 400, { error: "Invalid campaign dispatch command" });
      return;
    }

    const dedupeKey = `${command.tenantId}:${command.campaignId}:${command.contactPhoneE164}`;
    if (idempotency.isDuplicate(dedupeKey)) {
      sendJson(res, 200, {
        status: "duplicate_ignored",
        campaignId: command.campaignId,
        tenantId: command.tenantId
      });
      return;
    }

    try {
      const result = await sendTemplate(command);
      logger.info("campaign_dispatch_result", {
        requestId: ctx.requestId,
        campaignId: result.campaignId,
        tenantId: result.tenantId,
        status: result.status,
        externalMessageId: result.externalMessageId
      });

      sendJson(res, 202, {
        requestId: ctx.requestId,
        result
      });
    } catch (error) {
      logger.error("dispatch_failed", {
        requestId: ctx.requestId,
        campaignId: command.campaignId,
        tenantId: command.tenantId,
        error: error instanceof Error ? error.message : String(error)
      });
      sendJson(res, 503, {
        error: "dispatch_failed",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  notFound(res);
});

server.listen(config.notificationWorkerPort, () => {
  logger.info("service_started", {
    port: config.notificationWorkerPort,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
