import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createEventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import {
  campaignSendLog,
  campaignStatsRepository,
  channelRepository,
  closePool,
  consentRepository,
  contactRepository,
  conversationRepository,
  healthCheck,
  messageRepository,
  resolveChannelByPhoneNumberId,
  type ChannelCredentials
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
  type MessageCategory,
  type WhatsAppOutboundRequest
} from "@hyfib/shared-core";
import { buildOutboundAdapterCall } from "./outbound.js";

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
  profileName?: string;
  media?: Record<string, unknown>;
  interactive?: Record<string, unknown>;
  button?: Record<string, unknown>;
  location?: Record<string, unknown>;
  reaction?: Record<string, unknown>;
  contacts?: unknown[];
  referral?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

interface StatusEvent {
  phoneNumberId?: string;
  messageId?: string;
  status?: string;
  recipientId?: string;
  pricing?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  errors?: unknown[];
}

const META_STATUS_TO_MESSAGE: Record<string, Message["status"]> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed"
};

/** POSTs a send request to a meta-adapter endpoint and returns the message id. */
async function callMetaAdapter(
  endpoint: string,
  tenantId: string,
  payload: Record<string, unknown>
): Promise<{ messageId?: string; accepted: boolean }> {
  const response = await fetch(`${config.metaAdapterUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tenant-id": tenantId, "x-request-id": randomUUID() },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as { result?: { messageId?: string; status?: string } };
  if (!response.ok) {
    throw new Error(`meta_adapter_rejected_${response.status}`);
  }
  return { messageId: body.result?.messageId, accepted: body.result?.status === "accepted" };
}

/**
 * Resolves the sending channel's number + per-tenant token. Falls back to the
 * env phone number id only when the channel cannot be loaded (legacy single-WABA).
 */
async function resolveSendChannel(tenantId: string, channelId: string): Promise<ChannelCredentials> {
  const credentials = await channelRepository.getCredentials(tenantId, channelId);
  if (credentials) {
    return credentials;
  }
  return { id: channelId, wabaId: config.whatsappWabaId, phoneNumberId: config.whatsappPhoneNumberId };
}

async function sendTemplate(
  command: CampaignDispatchRequest,
  channel: ChannelCredentials
): Promise<{ messageId?: string; accepted: boolean }> {
  return callMetaAdapter("/internal/v1/whatsapp/send-template", command.tenantId, {
    phoneNumberId: channel.phoneNumberId,
    to: command.contactPhoneE164,
    templateName: command.templateName,
    templateLanguage: command.templateLanguage,
    parameters: command.parameters,
    accessToken: channel.accessToken
  });
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
    const channel = await resolveSendChannel(command.tenantId, command.channelId);
    const result = await sendTemplate(command, channel);
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

/**
 * Sends an outbound session (non-template) message requested by an agent and
 * persists it to the conversation. Uses the channel's number + per-tenant token.
 */
async function handleOutbound(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", {
    topic: EventTopics.WhatsAppOutboundRequested
  });
  const command = event.payload as WhatsAppOutboundRequest;
  if (!command.tenantId || !command.channelId || !command.conversationId || !command.contactPhoneE164) {
    logger.warn("outbound_invalid_command", { eventId: event.id });
    return;
  }
  const channel = await resolveSendChannel(command.tenantId, command.channelId);

  const call = buildOutboundAdapterCall(command, channel);
  const result = await callMetaAdapter(call.endpoint, command.tenantId, call.payload);

  await messageRepository.create(command.tenantId, {
    conversationId: command.conversationId,
    direction: "outbound",
    status: result.accepted ? "sent" : "queued",
    category: "service" as MessageCategory,
    externalMessageId: result.messageId,
    payload: call.persistedPayload
  });
  incCounter("whatsapp_messages_sent_total", "Outbound WhatsApp template sends.", {
    result: result.accepted ? "accepted" : "queued"
  });
  logger.info("outbound_sent", { conversationId: command.conversationId, externalMessageId: result.messageId });
}

/** Best-effort read receipt; never fails the inbound pipeline. */
async function markRead(channel: ChannelCredentials, messageId: string | undefined, tenantId: string): Promise<void> {
  if (!messageId) {
    return;
  }
  try {
    await fetch(`${config.metaAdapterUrl}/internal/v1/whatsapp/mark-read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-id": tenantId, "x-request-id": randomUUID() },
      body: JSON.stringify({ phoneNumberId: channel.phoneNumberId, messageId, accessToken: channel.accessToken })
    });
  } catch (error) {
    logger.warn("mark_read_failed", { error: error instanceof Error ? error.message : String(error) });
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
  // Persist the full normalized message (text + any media/interactive/location/etc.).
  const payload: Record<string, unknown> = { type: inbound.type, timestamp: inbound.timestamp };
  for (const field of [
    "text",
    "profileName",
    "media",
    "interactive",
    "button",
    "location",
    "reaction",
    "contacts",
    "referral",
    "context"
  ] as const) {
    if (inbound[field] !== undefined) {
      payload[field] = inbound[field];
    }
  }
  await messageRepository.create(channel.tenantId, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    externalMessageId: inbound.messageId,
    payload
  });
  logger.info("inbound_recorded", { tenantId: channel.tenantId, messageId: inbound.messageId, type: inbound.type });

  // Send a read receipt (best-effort) using the resolved channel's credentials.
  const sendChannel = await resolveSendChannel(channel.tenantId, channel.channelId);
  await markRead(sendChannel, inbound.messageId, channel.tenantId);

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
  const metaPatch: Record<string, unknown> = {};
  if (status.pricing) {
    metaPatch.pricing = status.pricing;
  }
  if (status.conversation) {
    metaPatch.conversation = status.conversation;
  }
  if (mapped === "failed" && status.errors && status.errors.length > 0) {
    metaPatch.error = status.errors[0];
  }
  await messageRepository.applyStatusUpdate(channel.tenantId, status.messageId, mapped, metaPatch);
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
eventBus.subscribe(EventTopics.WhatsAppOutboundRequested, "outbound-messages", handleOutbound);

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
