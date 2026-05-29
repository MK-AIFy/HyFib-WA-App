import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createEventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import {
  campaignSendLog,
  campaignStatsRepository,
  closePool,
  consentRepository,
  contactRepository,
  conversationRepository,
  healthCheck,
  messageRepository,
  resolveChannelByPhoneNumberId
} from "@hyfib/persistence";
import {
  EventTopics,
  Logger,
  parseUrlPath,
  sendJson,
  sendMetrics,
  incCounter,
  isOptInKeyword,
  isOptOutKeyword,
  type CampaignDispatchRequest,
  type EventEnvelope,
  type Message,
  type MessageCategory
} from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("message-worker", config.logLevel as "debug" | "info" | "warn" | "error");
const eventBus = createEventBus(config);

interface InboundEvent {
  phoneNumberId?: string;
  messageId?: string;
  from?: string;
  text?: string;
  type?: string;
  timestamp?: string;
}

interface StatusEvent {
  phoneNumberId?: string;
  messageId?: string;
  status?: string;
  recipientId?: string;
}

const META_STATUS_TO_MESSAGE: Record<string, Message["status"]> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed"
};

async function sendTemplate(command: CampaignDispatchRequest): Promise<{ messageId?: string; accepted: boolean }> {
  const response = await fetch(`${config.metaAdapterUrl}/internal/v1/whatsapp/send-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tenant-id": command.tenantId, "x-request-id": randomUUID() },
    body: JSON.stringify({
      phoneNumberId: config.whatsappPhoneNumberId,
      to: command.contactPhoneE164,
      templateName: command.templateName,
      templateLanguage: command.templateLanguage,
      parameters: command.parameters
    })
  });
  const body = (await response.json()) as { result?: { messageId?: string; status?: string } };
  if (!response.ok) {
    throw new Error(`meta_adapter_rejected_${response.status}`);
  }
  return { messageId: body.result?.messageId, accepted: body.result?.status === "accepted" };
}

async function recordOutbound(
  command: CampaignDispatchRequest,
  messageId: string | undefined,
  accepted: boolean
): Promise<void> {
  const contact = await contactRepository.findOrCreateByPhone(command.tenantId, command.contactPhoneE164);
  const conversation = await conversationRepository.findOrCreate(command.tenantId, contact.id, command.channelId);
  await messageRepository.create(command.tenantId, {
    conversationId: conversation.id,
    direction: "outbound",
    status: accepted ? "sent" : "queued",
    category: command.templateCategory as MessageCategory,
    externalMessageId: messageId,
    payload: { campaignId: command.campaignId, templateName: command.templateName, parameters: command.parameters }
  });
}

async function handleDispatch(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", {
    topic: EventTopics.CampaignDispatchRequested
  });
  const command = event.payload as CampaignDispatchRequest;
  if (!command.campaignId || !command.tenantId || !command.contactPhoneE164) {
    logger.warn("dispatch_invalid_command", { eventId: event.id });
    return;
  }
  // Dedupe: claim before sending; release on failure so redelivery can retry.
  const claimed = await campaignSendLog.tryClaim(command.tenantId, command.campaignId, command.contactPhoneE164);
  if (!claimed) {
    logger.info("dispatch_duplicate_skipped", { campaignId: command.campaignId });
    return;
  }
  try {
    const result = await sendTemplate(command);
    await recordOutbound(command, result.messageId, result.accepted);
    incCounter("whatsapp_messages_sent_total", "Outbound WhatsApp template sends.", {
      result: result.accepted ? "accepted" : "queued"
    });
    await eventBus.publish(
      EventTopics.CampaignDispatchResult,
      {
        campaignId: command.campaignId,
        tenantId: command.tenantId,
        externalMessageId: result.messageId,
        status: result.accepted ? "sent" : "queued"
      },
      command.tenantId
    );
    logger.info("dispatch_sent", { campaignId: command.campaignId, externalMessageId: result.messageId });
  } catch (error) {
    await campaignSendLog
      .release(command.tenantId, command.campaignId, command.contactPhoneE164)
      .catch(() => undefined);
    logger.error("dispatch_failed", {
      campaignId: command.campaignId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error; // Trigger broker retry / DLQ.
  }
}

async function handleInbound(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", { topic: EventTopics.WhatsAppInboundReceived });
  const inbound = event.payload as InboundEvent;
  if (!inbound.phoneNumberId || !inbound.from) {
    return;
  }
  const channel = await resolveChannelByPhoneNumberId(inbound.phoneNumberId);
  if (!channel) {
    logger.warn("inbound_unroutable", { phoneNumberId: inbound.phoneNumberId });
    return;
  }
  const contact = await contactRepository.findOrCreateByPhone(channel.tenantId, inbound.from);
  const conversation = await conversationRepository.findOrCreate(channel.tenantId, contact.id, channel.channelId);
  await messageRepository.create(channel.tenantId, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    externalMessageId: inbound.messageId,
    payload: { text: inbound.text, type: inbound.type, timestamp: inbound.timestamp }
  });
  logger.info("inbound_recorded", { tenantId: channel.tenantId, messageId: inbound.messageId });

  // Honour inbound STOP/START so opt-outs are respected automatically.
  if (isOptOutKeyword(inbound.text)) {
    await consentRepository.revoke(channel.tenantId, contact.id, "inbound_stop");
    await contactRepository.setOptedOut(channel.tenantId, contact.id, true);
    await eventBus.publish(
      EventTopics.ComplianceOptOutEvent,
      { tenantId: channel.tenantId, contactId: contact.id, phoneE164: contact.phoneE164, reason: "inbound_stop" },
      channel.tenantId
    );
    incCounter("contact_opt_outs_total", "Contacts opted out.", { source: "inbound_stop" });
    logger.info("inbound_opt_out", { tenantId: channel.tenantId, contactId: contact.id });
  } else if (isOptInKeyword(inbound.text)) {
    await consentRepository.grant(channel.tenantId, contact.id, { source: "inbound_start", policyVersion: "v1" });
    await contactRepository.setOptedOut(channel.tenantId, contact.id, false);
    incCounter("contact_opt_ins_total", "Contacts opted in.", { source: "inbound_start" });
    logger.info("inbound_opt_in", { tenantId: channel.tenantId, contactId: contact.id });
  }
}

async function handleStatus(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", { topic: EventTopics.WhatsAppStatusUpdated });
  const status = event.payload as StatusEvent;
  if (!status.phoneNumberId || !status.messageId || !status.status) {
    return;
  }
  const mapped = META_STATUS_TO_MESSAGE[status.status];
  if (!mapped) {
    return;
  }
  const channel = await resolveChannelByPhoneNumberId(status.phoneNumberId);
  if (!channel) {
    return;
  }
  await messageRepository.updateStatusByExternalId(channel.tenantId, status.messageId, mapped);
}

interface DispatchResultEvent {
  campaignId?: string;
  tenantId?: string;
  status?: string;
}

async function handleDispatchResult(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", { topic: EventTopics.CampaignDispatchResult });
  const result = event.payload as DispatchResultEvent;
  if (!result.tenantId || !result.campaignId) {
    return;
  }
  const outcome = result.status === "failed" ? "failed" : "sent";
  await campaignStatsRepository.recordResult(result.tenantId, result.campaignId, outcome);
}

eventBus.subscribe(EventTopics.CampaignDispatchRequested, "campaign-dispatch", handleDispatch);
eventBus.subscribe(EventTopics.CampaignDispatchResult, "campaign-results", handleDispatchResult);
eventBus.subscribe(EventTopics.WhatsAppInboundReceived, "inbound-messages", handleInbound);
eventBus.subscribe(EventTopics.WhatsAppStatusUpdated, "status-updates", handleStatus);

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
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
      service: "message-worker",
      status: db ? "ok" : "degraded",
      database: db,
      timestamp: new Date().toISOString()
    });
    return;
  }
  sendJson(res, 404, { error: "route_not_found" });
});

server.listen(config.notificationWorkerPort, () => {
  logger.info("service_started", {
    port: config.notificationWorkerPort,
    nodeEnv: config.nodeEnv,
    eventBus: config.eventBus
  });
});

server.on("error", (error) => {
  logger.error("service_error", { error: error instanceof Error ? error.message : String(error) });
});

async function shutdown(signal: string): Promise<void> {
  logger.info("shutdown_started", { signal });
  server.close(async () => {
    await eventBus.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
