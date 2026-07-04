import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, type EventBus } from "@hyfib/event-bus";
import { loadConfig } from "@hyfib/config";
import { evaluateOutboundPolicy } from "@hyfib/policy-engine";
import {
  autoReplyRuleRepository,
  automationRuleRepository,
  billingRepository,
  campaignRecipientRepository,
  campaignSendLog,
  campaignStatsRepository,
  channelRepository,
  closePool,
  consentRepository,
  contactRepository,
  conversationRepository,
  healthCheck,
  messageRepository,
  outboxRepository,
  resolveChannelByPhoneNumberId,
  taskRepository,
  userRepository,
  whatsappSettingsRepository,
  withTenant,
  type ChannelCredentials,
  type OutboxEnqueueInput
} from "@hyfib/persistence";
import { getRedisClient, acquireRateLimit } from "@hyfib/ratelimit";
import {
  EventTopics,
  Logger,
  parseUrlPath,
  sendJson,
  sendMetrics,
  incCounter,
  isOptInKeyword,
  isOptOutKeyword,
  type AutomationTemplateRequest,
  type CampaignDispatchRequest,
  type CampaignRunRequest,
  type EventEnvelope,
  type Message,
  type MessageCategory,
  type WhatsAppOutboundRequest
} from "@hyfib/shared-core";
import { buildOutboundAdapterCall } from "./outbound.js";
import { resolveVariables } from "./personalize.js";
import { matchAutoReply } from "./autoreply.js";
import { evaluateAutomationRules } from "./automation.js";

const config = loadConfig();
const logger = new Logger("notification-worker", config.logLevel as "debug" | "info" | "warn" | "error");
let eventBus = createEventBus(config);
const redis = getRedisClient(config);

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

/**
 * Meta send transport. Injectable so the modular monolith swaps the HTTP calls
 * to the meta-adapter for direct in-process function calls (Phase 5); the
 * standalone worker keeps the fetch implementation below.
 */
export interface WorkerMetaClient {
  send(
    endpoint: string,
    tenantId: string,
    payload: Record<string, unknown>
  ): Promise<{ messageId?: string; accepted: boolean }>;
  markRead(
    phoneNumberId: string,
    messageId: string,
    tenantId: string,
    accessToken?: string
  ): Promise<void>;
}

const defaultMetaClient: WorkerMetaClient = {
  async send(endpoint, tenantId, payload) {
    const response = await fetch(`${config.metaAdapterUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
        "x-request-id": randomUUID(),
        "x-internal-secret": config.internalServiceSecret
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000)
    });
    const body = (await response.json()) as { result?: { messageId?: string; status?: string } };
    if (!response.ok) {
      throw new Error(`meta_adapter_rejected_${response.status}`);
    }
    return { messageId: body.result?.messageId, accepted: body.result?.status === "accepted" };
  },
  async markRead(phoneNumberId, messageId, tenantId, accessToken) {
    try {
      await fetch(`${config.metaAdapterUrl}/internal/v1/whatsapp/mark-read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          "x-request-id": randomUUID(),
          "x-internal-secret": config.internalServiceSecret
        },
        body: JSON.stringify({ phoneNumberId, messageId, accessToken }),
        signal: AbortSignal.timeout(5_000)
      });
    } catch (error) {
      logger.warn("mark_read_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
};

let metaClient: WorkerMetaClient = defaultMetaClient;

/** POSTs a send request to the meta transport and returns the message id. */
async function callMetaAdapter(
  endpoint: string,
  tenantId: string,
  payload: Record<string, unknown>
): Promise<{ messageId?: string; accepted: boolean }> {
  return metaClient.send(endpoint, tenantId, payload);
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
    // Enforce monthly message quota if configured on the tenant's WhatsApp settings.
    const waSettings = await whatsappSettingsRepository.getByTenant(command.tenantId);
    const monthlyQuota = (waSettings as unknown as Record<string, unknown>)?.monthlyMessageQuota as number | undefined;
    if (monthlyQuota) {
      const used = await billingRepository.getMonthlyOutboundCount(command.tenantId);
      if (used >= monthlyQuota) {
        logger.warn("monthly_quota_exceeded", {
          tenantId: command.tenantId,
          used,
          quota: monthlyQuota
        });
        if (command.recipientId) {
          await campaignRecipientRepository
            .updateStatus(command.tenantId, command.recipientId, {
              status: "failed",
              error: "monthly_quota_exceeded"
            })
            .catch(() => undefined);
        }
        await campaignSendLog
          .release(command.tenantId, command.campaignId, command.contactPhoneE164)
          .catch(() => undefined);
        return;
      }
    }

    const channel = await resolveSendChannel(command.tenantId, command.channelId);
    const result = await sendTemplate(command, channel);
    await recordOutbound(command, result.messageId, result.accepted);

    // Update the per-recipient funnel row when this is a fan-out send.
    if (command.recipientId) {
      await campaignRecipientRepository.updateStatus(command.tenantId, command.recipientId, {
        status: result.accepted ? "sent" : "failed",
        externalMessageId: result.messageId
      });
    }

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

    if (command.recipientId) {
      await campaignRecipientRepository
        .updateStatus(command.tenantId, command.recipientId, {
          status: "failed",
          error: error instanceof Error ? error.message : "send_failed"
        })
        .catch(() => undefined);
    }

    logger.error("dispatch_failed", {
      campaignId: command.campaignId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error; // Trigger broker retry / DLQ.
  }
}

/**
 * Fan-out consumer: picks up CampaignRunRequested, batches through
 * campaign_recipients applying per-contact policy + personalisation + rate pacing,
 * then enqueues individual CampaignDispatchRequested events.
 *
 * This runs as a single-consumer loop so the pacing token bucket is effective.
 * On restart it continues from wherever pending rows remain (idempotent inserts).
 */
async function handleCampaignRun(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", {
    topic: EventTopics.CampaignRunRequested
  });
  const run = event.payload as CampaignRunRequest;
  if (!run.campaignId || !run.tenantId || !run.channelId) {
    logger.warn("campaign_run_invalid", { eventId: event.id });
    return;
  }

  const channel = await resolveSendChannel(run.tenantId, run.channelId);
  const rateScopeKey = `campaign:${run.campaignId}:${channel.phoneNumberId}`;
  const ratePerMinute = run.ratePerMinute ?? 60;

  logger.info("campaign_run_started", { campaignId: run.campaignId, tenantId: run.tenantId });

  // Process in batches of 50; claimPendingBatch advisory-locks rows so a
  // restarted worker won't re-dispatch the same contacts.
  let processed = 0;
  let batches = 0;
  const MAX_BATCHES = 10_000; // Safety limit (~500K contacts per invocation)
  // Pre-compute the frequency-cap since-date once per run (shared across all recipients).
  const frequencyCapSince = run.frequencyCap
    ? new Date(Date.now() - run.frequencyCap.periodHours * 60 * 60 * 1000).toISOString()
    : null;

  while (batches < MAX_BATCHES) {
    const batch = await campaignRecipientRepository.claimPendingBatch(run.tenantId, run.campaignId, 50);
    if (batch.length === 0) break;
    batches++;

    // Batch-load all data needed for policy evaluation in 3-4 parallel queries
    // instead of 4 sequential per-contact queries (N+1 → O(1) per batch).
    const contactIds = batch.map((r) => r.contactId);
    const [contactMap, consentSet, lastInboundMap, freqCapMap] = await Promise.all([
      contactRepository.getByIds(run.tenantId, contactIds),
      consentRepository.hasConsentBatch(run.tenantId, contactIds),
      conversationRepository.lastInboundAtBatch(run.tenantId, contactIds),
      frequencyCapSince
        ? messageRepository.countOutboundSinceBatch(run.tenantId, contactIds, frequencyCapSince)
        : Promise.resolve(new Map<string, number>())
    ]);

    // Collect approved dispatch events; batch-enqueue after the rate-limit loop.
    const toEnqueue: OutboxEnqueueInput[] = [];

    for (const recipient of batch) {
      const contact = contactMap.get(recipient.contactId);
      if (!contact) {
        await campaignRecipientRepository.updateStatus(run.tenantId, recipient.id, {
          status: "failed",
          error: "contact_not_found"
        });
        continue;
      }

      const hasActiveConsent = consentSet.has(contact.id);
      const isOptedOut = contact.optedOut;
      const lastInboundAt = lastInboundMap.get(contact.id);
      const isInside24hWindow = lastInboundAt ? Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000 : false;
      const currentHourLocal = getCurrentHourInTz(contact.timezone ?? "UTC");
      const sentInPeriod = freqCapMap.get(contact.id) ?? 0;

      const policy = evaluateOutboundPolicy({
        hasActiveConsent,
        isInside24hWindow,
        template: {
          category: run.templateCategory,
          status: run.templateStatus ?? "approved"
        } as import("@hyfib/shared-core").Template,
        requestedCategory: run.templateCategory,
        isOptedOut,
        currentHourLocal,
        quietHours: run.quietHours,
        frequencyCap: run.frequencyCap ? { ...run.frequencyCap, sentInPeriod } : undefined
      });

      if (!policy.allowed) {
        await campaignRecipientRepository.updateStatus(run.tenantId, recipient.id, {
          status: "policy_skipped",
          error: policy.reason
        });
        continue;
      }

      const parameters = resolveVariables(run.variableMapping, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        phoneE164: contact.phoneE164,
        country: contact.country,
        tags: contact.tags ?? [],
        timezone: contact.timezone
      });

      // Rate pacing: acquire a slot from the token bucket; waits if needed.
      await acquireRateLimit(redis, rateScopeKey, ratePerMinute).catch(() => undefined);

      toEnqueue.push({
        topic: EventTopics.CampaignDispatchRequested,
        payload: {
          campaignId: run.campaignId,
          tenantId: run.tenantId,
          channelId: run.channelId,
          templateName: run.templateName,
          templateLanguage: run.templateLanguage,
          templateCategory: run.templateCategory,
          contactPhoneE164: recipient.phoneE164,
          parameters,
          recipientId: recipient.id
        } satisfies CampaignDispatchRequest
      });
      processed++;
    }

    // Batch-insert all approved dispatch events in a single transaction.
    if (toEnqueue.length > 0) {
      await withTenant(run.tenantId, async (client) => {
        await outboxRepository.enqueueBatch(client, run.tenantId, toEnqueue);
      });
    }
  }

  if (batches >= MAX_BATCHES) {
    logger.warn("campaign_run_max_batches_hit", {
      campaignId: run.campaignId,
      processed,
      maxBatches: MAX_BATCHES
    });
  }
  logger.info("campaign_run_completed", { campaignId: run.campaignId, processed });
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
  let result: { messageId?: string; accepted: boolean };
  try {
    result = await callMetaAdapter(call.endpoint, command.tenantId, call.payload);
  } catch (error) {
    logger.error("outbound_adapter_failed", {
      conversationId: command.conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error; // Re-throw so the broker can retry.
  }

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
  await metaClient.markRead(channel.phoneNumberId, messageId, tenantId, channel.accessToken);
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

  // Stamp last_inbound_at for 24h session window tracking.
  await conversationRepository.touchInbound(channel.tenantId, conversation.id);

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
    return; // Don't auto-reply after STOP.
  }

  if (isOptInKeyword(inbound.text)) {
    await consentRepository.grant(channel.tenantId, contact.id, { source: "inbound_start", policyVersion: "v1" });
    await contactRepository.setOptedOut(channel.tenantId, contact.id, false);
    incCounter("contact_opt_ins_total", "Contacts opted in.", { source: "inbound_start" });
    logger.info("inbound_opt_in", { tenantId: channel.tenantId, contactId: contact.id });
  }

  // Auto-reply evaluation (only text/button messages; skip reactions, read receipts).
  if (inbound.type === "text" || inbound.type === "button" || inbound.type === "interactive") {
    const rules = await autoReplyRuleRepository.listEnabled(channel.tenantId);
    const interactivePayload = inbound.interactive as
      | { button_reply?: { title?: string }; list_reply?: { title?: string } }
      | undefined;
    const interactiveTitle =
      interactivePayload?.button_reply?.title ?? interactivePayload?.list_reply?.title;
    const text = (typeof inbound.text === "string" && inbound.text)
      ? inbound.text
      : interactiveTitle;
    const matched = matchAutoReply(text, rules);
    if (matched && matched.replyText) {
      await withTenant(channel.tenantId, async (client) => {
        await outboxRepository.enqueue(client, channel.tenantId, {
          topic: EventTopics.WhatsAppOutboundRequested,
          payload: {
            tenantId: channel.tenantId,
            channelId: channel.channelId,
            conversationId: conversation.id,
            contactPhoneE164: contact.phoneE164,
            kind: "text",
            text: matched.replyText
          } satisfies WhatsAppOutboundRequest
        });
      });
      incCounter("auto_replies_sent_total", "Auto-reply messages enqueued.", { matchType: matched.matchType });
      logger.info("auto_reply_enqueued", {
        tenantId: channel.tenantId,
        conversationId: conversation.id,
        ruleId: matched.id
      });
    }

    // Automation rules: new_message trigger.
    await runNewMessageAutomation(channel.tenantId, conversation.id, contact, channel.channelId, text);
  }
}

/** Executes enabled new_message automation actions for an inbound message. */
async function runNewMessageAutomation(
  tenantId: string,
  conversationId: string,
  contact: { id: string; phoneE164: string },
  channelId: string,
  text: string | undefined
): Promise<void> {
  const rules = await automationRuleRepository.listEnabledByTrigger(tenantId, "new_message");
  if (rules.length === 0) {
    return;
  }
  const actions = evaluateAutomationRules("new_message", { messageText: text }, rules);
  for (const action of actions) {
    try {
      if (action.kind === "add_tag") {
        await contactRepository.addTag(tenantId, contact.id, action.tag);
      } else if (action.kind === "assign_agent") {
        // Only assign to a user that belongs to this tenant (RLS-scoped lookup).
        if (await userRepository.getById(tenantId, action.assigneeUserId)) {
          await conversationRepository.assign(tenantId, conversationId, action.assigneeUserId);
        } else {
          logger.warn("automation_assignee_not_in_tenant", { tenantId, assigneeUserId: action.assigneeUserId });
        }
      } else if (action.kind === "create_task") {
        const clampedMinutes =
          action.dueInMinutes && action.dueInMinutes > 0 ? Math.min(action.dueInMinutes, 525_600) : undefined;
        const dueAt = clampedMinutes ? new Date(Date.now() + clampedMinutes * 60_000).toISOString() : undefined;
        await taskRepository.create(tenantId, {
          title: action.title,
          contactId: contact.id,
          conversationId,
          dueAt,
          remindAt: dueAt,
          source: "automation"
        });
      } else if (action.kind === "send_template") {
        await withTenant(tenantId, async (client) => {
          await outboxRepository.enqueue(client, tenantId, {
            topic: EventTopics.AutomationTemplateRequested,
            payload: {
              tenantId,
              channelId,
              contactPhoneE164: contact.phoneE164,
              templateName: action.templateName,
              templateLanguage: action.templateLanguage
            }
          });
        });
      }
      incCounter("automation_actions_executed_total", "Automation actions executed.", { action: action.kind });
    } catch (error) {
      logger.error("automation_action_failed", {
        tenantId,
        action: action.kind,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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

  // Update delivery funnel in campaign_recipients (best-effort; row may not exist).
  if (mapped === "delivered" || mapped === "read" || mapped === "failed") {
    await campaignRecipientRepository
      .updateByExternalMessageId(channel.tenantId, status.messageId, mapped)
      .catch(() => undefined);
  }

  // Update aggregate campaign stats for delivered/read.
  if (mapped === "delivered" || mapped === "read") {
    // Look up the message to find campaignId (best-effort).
    const message = await messageRepository.findByExternalId(channel.tenantId, status.messageId).catch(() => undefined);
    if (message?.payload && typeof message.payload === "object") {
      const campaignId = (message.payload as { campaignId?: string }).campaignId;
      if (campaignId) {
        if (mapped === "delivered") {
          await campaignStatsRepository.recordDelivered(channel.tenantId, campaignId).catch(() => undefined);
        } else if (mapped === "read") {
          await campaignStatsRepository.recordRead(channel.tenantId, campaignId).catch(() => undefined);
        }
      }
    }
  }
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

/** Sends a template requested by an automation rule action and records the outbound message. */
async function handleAutomationTemplate(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", {
    topic: EventTopics.AutomationTemplateRequested
  });
  const req = event.payload as AutomationTemplateRequest;
  if (!req.tenantId || !req.contactPhoneE164 || !req.templateName) {
    logger.warn("automation_template_invalid", { eventId: event.id });
    return;
  }

  // At-least-once delivery guard: skip if this event was already processed.
  const claimed = await redis.set(`atreq:${event.id}`, "1", "EX", 3600, "NX");
  if (!claimed) {
    logger.info("automation_template_duplicate_skipped", { eventId: event.id });
    return;
  }

  // Resolve contact and enforce consent + policy before sending
  const contact = await contactRepository.findOrCreateByPhone(req.tenantId, req.contactPhoneE164);
  if (contact.optedOut) {
    logger.warn("automation_template_opted_out", { tenantId: req.tenantId, contactId: contact.id });
    return;
  }
  const hasConsent = await consentRepository.hasActiveConsent(req.tenantId, contact.id);
  if (!hasConsent) {
    logger.warn("automation_template_no_consent", { tenantId: req.tenantId, contactId: contact.id });
    return;
  }
  const settings = await whatsappSettingsRepository.getByTenant(req.tenantId);
  const policyCheck = evaluateOutboundPolicy({
    hasActiveConsent: true,
    isInside24hWindow: false,
    template: { category: (req as any).templateCategory ?? "marketing", status: "approved" } as import("@hyfib/shared-core").Template,
    requestedCategory: ((req as any).templateCategory ?? "marketing") as import("@hyfib/shared-core").MessageCategory,
    isOptedOut: false,
    currentHourLocal: getCurrentHourInTz(contact.timezone ?? "UTC"),
    quietHours: (settings as unknown as { quietHours?: import("@hyfib/shared-core").QuietHoursConfig })?.quietHours,
    frequencyCap: undefined
  });
  if (!policyCheck.allowed) {
    logger.warn("automation_template_policy_blocked", { tenantId: req.tenantId, contactId: contact.id, reason: policyCheck.reason });
    return;
  }

  const channelId = req.channelId ?? (await channelRepository.firstActive(req.tenantId))?.id;
  if (!channelId) {
    logger.warn("automation_template_no_channel", { tenantId: req.tenantId });
    return;
  }
  const channel = await resolveSendChannel(req.tenantId, channelId);
  const result = await callMetaAdapter("/internal/v1/whatsapp/send-template", req.tenantId, {
    phoneNumberId: channel.phoneNumberId,
    to: req.contactPhoneE164,
    templateName: req.templateName,
    templateLanguage: req.templateLanguage,
    parameters: [],
    accessToken: channel.accessToken
  });
  const conversation = await conversationRepository.findOrCreate(req.tenantId, contact.id, channelId);
  await messageRepository.create(req.tenantId, {
    conversationId: conversation.id,
    direction: "outbound",
    status: result.accepted ? "sent" : "queued",
    category: "marketing" as MessageCategory,
    externalMessageId: result.messageId,
    payload: { source: "automation", templateName: req.templateName }
  });
  logger.info("automation_template_sent", { tenantId: req.tenantId, contactPhoneE164: req.contactPhoneE164, externalMessageId: result.messageId });
  incCounter("automation_template_sends_total", "Automation template sends.", {
    result: result.accepted ? "accepted" : "queued"
  });
}

export interface WorkerDeps {
  /** Shared in-process event bus (app-server). Falls back to the worker's own. */
  eventBus?: EventBus;
  /** Direct in-process meta transport (app-server). Falls back to HTTP fetch. */
  metaClient?: WorkerMetaClient;
}

/**
 * Register all worker consumers on the (possibly shared) event bus. In the
 * monolith app-server passes its shared bus + a direct meta client so the
 * worker consumes gateway-published events in-process.
 *
 * Durability: campaign runs and outbound sends are enqueued to the DB outbox by
 * the gateway; the gateway's outbox relay (started by app-server) re-publishes
 * unprocessed rows after a crash, and the synchronous in-memory bus + idempotent
 * claimPendingBatch make re-processing safe — so no separate resume sweep is
 * needed here.
 */
export function registerWorkerConsumers(deps: WorkerDeps = {}): void {
  if (deps.eventBus) {
    eventBus = deps.eventBus;
  }
  if (deps.metaClient) {
    metaClient = deps.metaClient;
  }
  eventBus.subscribe(EventTopics.CampaignDispatchRequested, "campaign-dispatch", handleDispatch);
  eventBus.subscribe(EventTopics.CampaignDispatchResult, "campaign-results", handleDispatchResult);
  eventBus.subscribe(EventTopics.CampaignRunRequested, "campaign-run", handleCampaignRun);
  eventBus.subscribe(EventTopics.WhatsAppInboundReceived, "inbound-messages", handleInbound);
  eventBus.subscribe(EventTopics.WhatsAppStatusUpdated, "status-updates", handleStatus);
  eventBus.subscribe(EventTopics.WhatsAppOutboundRequested, "outbound-messages", handleOutbound);
  eventBus.subscribe(EventTopics.AutomationTemplateRequested, "automation-templates", handleAutomationTemplate);
}

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
      service: "notification-worker",
      status: db ? "ok" : "degraded",
      database: db,
      timestamp: new Date().toISOString()
    });
    return;
  }
  sendJson(res, 404, { error: "route_not_found" });
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

// Boot the standalone worker only when executed directly; when imported by
// app-server, only registerWorkerConsumers() is used (on the shared bus).
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  registerWorkerConsumers();

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

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
