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
  automationSettingsRepository,
  campaignRepository,
  campaignSendLog,
  campaignStatsRepository,
  channelRepository,
  closePool,
  consentRepository,
  contactRepository,
  conversationRepository,
  flowRepository,
  healthCheck,
  linkClickRepository,
  mediaRepository,
  messageRepository,
  outboxRepository,
  resolveChannelByPhoneNumberId,
  sequenceRepository,
  taskRepository,
  teamRepository,
  userRepository,
  whatsappSettingsRepository,
  withTenant,
  type ChannelCredentials,
  type OutboxEnqueueInput
} from "@hyfib/persistence";
import { getRedisClient, checkRateLimit } from "@hyfib/ratelimit";
import { dispatchScheduleAt, continuationScheduleAt, isFinalBatch, BATCH_SIZE } from "./pacing.js";
import {
  EventTopics,
  Logger,
  advanceFlow,
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
  type MediaFetchRequest,
  type Message,
  type MessageCategory,
  type WhatsAppOutboundRequest
} from "@hyfib/shared-core";
import {
  buildOutboundAdapterCall,
  claimRedisKey,
  releaseRedisKey,
  dispatchClaimKey,
  DISPATCH_CLAIM_TTL_SECONDS
} from "./outbound.js";
import { resolveVariables } from "./personalize.js";
import { mintTrackedParameters } from "./click-tracking.js";
import { matchAutoReply } from "./autoreply.js";
import { evaluateAutomationRules } from "./automation.js";
import { decideDefaultAutomation } from "./default-automations.js";
import { processMediaFetch } from "./media.js";

const config = loadConfig();
const logger = new Logger("notification-worker", config.logLevel as "debug" | "info" | "warn" | "error");
let eventBus = createEventBus(config);
let redis = getRedisClient(config);
/** Phone-number-id → tenant/channel lookup (defaults to the DB-backed resolver; overridable via WorkerDeps). */
let resolveChannel: typeof resolveChannelByPhoneNumberId = resolveChannelByPhoneNumberId;

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
  markRead(phoneNumberId: string, messageId: string, tenantId: string, accessToken?: string): Promise<void>;
  /** Downloads inbound media bytes for a Graph media id. Throws on any non-success outcome. */
  fetchMedia(
    mediaId: string,
    tenantId: string,
    accessToken?: string
  ): Promise<{ buffer: Buffer; mimeType?: string; fileSizeBytes?: number }>;
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
  },
  async fetchMedia(mediaId, tenantId, accessToken) {
    const url = new URL(`${config.metaAdapterUrl}/internal/v1/whatsapp/media/${encodeURIComponent(mediaId)}/download`);
    if (accessToken) {
      url.searchParams.set("accessToken", accessToken);
    }
    const response = await fetch(url, {
      headers: {
        "x-tenant-id": tenantId,
        "x-request-id": randomUUID(),
        "x-internal-secret": config.internalServiceSecret
      },
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string };
        detail = body.error ? `_${body.error}` : "";
      } catch {
        // Non-JSON error body; fall back to the bare status.
      }
      throw new Error(`meta_adapter_media_fetch_failed_${response.status}${detail}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentLength = response.headers.get("content-length");
    return {
      buffer,
      mimeType: response.headers.get("content-type") ?? undefined,
      fileSizeBytes: contentLength ? Number(contentLength) : buffer.length
    };
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
  // Stop queued fan-out sends for a campaign that is no longer running. The
  // loop's own abort check stopped it claiming new batches, but everything
  // already written to the outbox would otherwise still send, so pause looked
  // ineffective for as long as the backlog took to drain.
  //
  // This runs BEFORE tryClaim deliberately. campaign_send_log rows are never
  // deleted on success, so claiming and then skipping would burn the
  // exactly-once claim on a message that never sent, and tryClaim would refuse
  // that recipient forever — resume would silently skip them.
  //
  // Only fan-out sends are gated. A dispatch with no recipientId is the
  // single-number test send: an explicit operator action rather than queued
  // work, and it must not even pay for the status read.
  //
  // Not cached on purpose. Any TTL is added pause latency, and getStatus is a
  // primary-key lookup — negligible beside the monthly COUNT(*) below.
  if (command.recipientId) {
    const campaignStatus = await campaignRepository.getStatus(command.tenantId, command.campaignId);
    if (campaignStatus !== "running") {
      // The recipient row is deliberately left 'pending' with its claimed_at
      // intact: the stale-claim reclaim makes it re-dispatchable once the
      // campaign resumes. Marking it here would make pause lossy.
      logger.info("dispatch_skipped_campaign_not_running", {
        campaignId: command.campaignId,
        status: campaignStatus ?? "missing"
      });
      return;
    }
  }

  // Hard rate cap, enforced without sleeping.
  //
  // Pacing is a schedule now, which is what freed the relay — but a schedule is
  // only advisory: if the relay falls behind, every backlogged row becomes
  // eligible at once and would burst past the campaign's configured rate. This
  // restores the cap by re-queueing an over-budget send for later instead of
  // blocking on it, so the relay stays free and the campaign still paces.
  //
  // checkRateLimit is the non-blocking half of the limiter — acquireRateLimit,
  // which sleeps, is exactly what must never run on this path. Deferring before
  // tryClaim keeps the exactly-once claim unburned, same reasoning as the
  // campaign-status guard above.
  if (command.recipientId && command.ratePerMinute) {
    const budget = await checkRateLimit(redis, `campaign:${command.campaignId}`, command.ratePerMinute);
    if (!budget.allowed) {
      await outboxRepository.enqueueOwn(command.tenantId, {
        topic: EventTopics.CampaignDispatchRequested,
        payload: { ...command } as unknown as Record<string, unknown>,
        nextAttemptAt: new Date(Date.now() + budget.waitMs)
      });
      logger.info("dispatch_deferred_rate_cap", {
        campaignId: command.campaignId,
        waitMs: budget.waitMs
      });
      return;
    }
  }

  // Dedupe: claim before sending; release on failure so redelivery can retry.
  const claimed = await campaignSendLog.tryClaim(command.tenantId, command.campaignId, command.contactPhoneE164);
  if (!claimed) {
    logger.info("dispatch_duplicate_skipped", { campaignId: command.campaignId });
    // Record the suppression on the funnel row, otherwise it stays 'pending'
    // forever: claimPendingBatch reclaims stale claims, so a permanently-pending
    // recipient is re-claimed and re-enqueued every stale window and the
    // campaign never drains. Guarded on 'pending' so an outbox redelivery for a
    // recipient that already sent cannot downgrade it. Best-effort, like the
    // quota gate below — a bookkeeping failure must not rethrow, since broker
    // retry would only re-suppress.
    if (command.recipientId) {
      await campaignRecipientRepository
        .updateStatus(command.tenantId, command.recipientId, {
          status: "policy_skipped",
          skipReason: "duplicate_send_suppressed",
          onlyIfStatus: "pending"
        })
        .catch((error) =>
          logger.warn("dispatch_duplicate_recipient_update_failed", {
            campaignId: command.campaignId,
            recipientId: command.recipientId,
            error: error instanceof Error ? error.message : String(error)
          })
        );
    }
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

  // The channel is no longer resolved here. It was only needed to build the
  // token-bucket scope key for the pacing sleep; handleDispatch resolves its own
  // channel at send time, so reading credentials per batch was pure dead work.
  const ratePerMinute = run.ratePerMinute ?? 60;
  // Every send scheduled by this invocation is offset from a single instant, so
  // the batch is spread evenly rather than clustered at whatever moment each
  // recipient happened to be processed.
  const runStartedAt = Date.now();
  let scheduled = 0;

  logger.info("campaign_run_started", { campaignId: run.campaignId, tenantId: run.tenantId });

  // Exactly one batch per invocation, then return. Re-entry happens through a
  // scheduled continuation event, not a loop: looping here is what made a run
  // hold the outbox relay — and therefore every outbound message in the system —
  // for its entire duration.
  //
  // claimPendingBatch stamps claimed_at on the rows it returns, so a restarted
  // worker or a second concurrent invocation never re-dispatches the same
  // contacts. Claims older than the repository's stale window are reclaimable,
  // so a crash between claiming and enqueueing does not strand recipients.
  let processed = 0;
  // Pre-compute the frequency-cap since-date once (shared across all recipients).
  const frequencyCapSince = run.frequencyCap
    ? new Date(Date.now() - run.frequencyCap.periodHours * 60 * 60 * 1000).toISOString()
    : null;

  // Re-read the status before claiming work. The event payload is a frozen
  // snapshot taken when the run was first requested, so it can never reflect a
  // pause — this poll is the only way an in-flight campaign learns about one.
  // It costs one single-column read per batch.
  //
  // Checking before the claim is what makes pause mean "no new batches are
  // started": the batch already in hand runs to completion, so its claimed
  // recipients are not stranded mid-flight. Worst-case pause latency is one
  // batch window, roughly a minute at the default 60/min.
  const status = await campaignRepository.getStatus(run.tenantId, run.campaignId);
  if (status !== "running") {
    logger.info("campaign_run_stopped", { campaignId: run.campaignId, status: status ?? "missing", processed });
    return;
  }

  const batch = await campaignRecipientRepository.claimPendingBatch(run.tenantId, run.campaignId, BATCH_SIZE);
  if (batch.length === 0) {
    logger.info("campaign_run_completed", { campaignId: run.campaignId, processed, exitReason: "drained" });
    return;
  }

  {
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

      let parameters = resolveVariables(run.variableMapping, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        phoneE164: contact.phoneE164,
        country: contact.country,
        tags: contact.tags ?? [],
        timezone: contact.timezone
      });

      if (config.linkTrackingEnabled) {
        parameters = await mintTrackedParameters(parameters, {
          baseUrl: config.platformBaseUrl,
          createLink: (token, destination) =>
            linkClickRepository.create(run.tenantId, {
              token,
              destination,
              campaignId: run.campaignId,
              contactId: contact.id
            }),
          onError: (err, destination) =>
            logger.warn("link_tracking_mint_failed", {
              campaignId: run.campaignId,
              contactId: contact.id,
              destination,
              error: err instanceof Error ? err.message : String(err)
            })
        });
      }

      // Rate pacing is a schedule, not a sleep. This used to call
      // acquireRateLimit, which blocks until a token-bucket slot frees up —
      // and because the in-memory bus awaits its handler while the outbox relay
      // holds a re-entrancy guard, that blocked every outbound message
      // platform-wide for the whole run (~2.8h for 10k at the default 60/min).
      // Stamping the row instead lets the relay's next_attempt_at filter pace
      // delivery while this handler returns immediately.
      toEnqueue.push({
        nextAttemptAt: dispatchScheduleAt(runStartedAt, scheduled++, ratePerMinute),
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
          recipientId: recipient.id,
          // Carried so the dispatch can enforce the cap if the relay ever runs
          // the backlog faster than this schedule intended.
          ratePerMinute
        } satisfies CampaignDispatchRequest
      });
      processed++;
    }

    // A full batch means more recipients may remain, so this run must re-enter.
    // The continuation is scheduled a whole batch-window ahead: re-entering
    // sooner would claim and schedule faster than the previous batch is being
    // delivered, piling up outbox rows and defeating the pacing.
    //
    // It rides the same durable outbox as the dispatches — retried, and
    // dead-lettered after the usual attempt cap — rather than being held in
    // memory, so a crash between batches does not abandon the campaign.
    if (!isFinalBatch(batch.length)) {
      toEnqueue.push({
        nextAttemptAt: continuationScheduleAt(runStartedAt, ratePerMinute),
        topic: EventTopics.CampaignRunRequested,
        payload: { ...run } as unknown as Record<string, unknown>
      });
    }

    // Batch-insert the approved dispatch events and any continuation in a
    // single transaction, so a campaign can never lose its continuation while
    // keeping the sends it belongs to.
    if (toEnqueue.length > 0) {
      await withTenant(run.tenantId, async (client) => {
        await outboxRepository.enqueueBatch(client, run.tenantId, toEnqueue);
      });
    }
  }

  // This handler deliberately does NOT write 'completed'. An empty claim batch
  // means "nothing unclaimed right now", not "finished": claimPendingBatch
  // excludes rows it just stamped with claimed_at, so the recipients claimed on
  // the previous iteration are still pending with their dispatch rows queued in
  // the outbox. Completing here marked a campaign finished while its own sends
  // were still in flight, and the dispatch-time status guard then correctly
  // refused to send them — the campaign delivered nothing.
  //
  // Completion is owned solely by complete_drained_campaigns
  // (023_campaign_completion.sql), swept by the gateway once the sends actually
  // resolve.
  logger.info("campaign_run_completed", { campaignId: run.campaignId, processed, exitReason: "batch_scheduled" });
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

  // Replay guard: a redelivered outbox row is re-published with a NEW envelope id, so
  // claim on the caller-assigned dispatchId (stable across replay) instead of event.id.
  // No dispatchId means no guard — current unguarded behavior is unchanged.
  const claimKey = command.dispatchId ? dispatchClaimKey(command.dispatchId) : undefined;
  if (claimKey) {
    const claimed = await claimRedisKey(redis, claimKey, DISPATCH_CLAIM_TTL_SECONDS);
    if (!claimed) {
      // Skip branch stays outside the try below: a skip must not release another
      // in-flight attempt's claim.
      logger.info("outbound_replay_skipped", {
        conversationId: command.conversationId,
        dispatchId: command.dispatchId
      });
      return;
    }
  }

  // Everything from the successful claim through a completed send is guarded: any
  // exception here (channel resolution, payload building, or the adapter call itself)
  // releases the claim so a retry with the same dispatchId can resend instead of being
  // silently dropped as an "already claimed" replay. On success the claim is left in
  // place — it's the 24h dedupe record.
  let result: { messageId?: string; accepted: boolean };
  let persistedPayload: Record<string, unknown>;
  // Distinguishes pre-send failures (channel resolution, payload building →
  // outbound_send_failed) from the adapter call itself (outbound_adapter_failed)
  // so dashboards don't blame the meta-adapter for local preparation errors.
  let adapterCallStarted = false;
  try {
    const channel = await resolveSendChannel(command.tenantId, command.channelId);
    const call = buildOutboundAdapterCall(command, channel);
    persistedPayload = call.persistedPayload;
    adapterCallStarted = true;
    result = await callMetaAdapter(call.endpoint, command.tenantId, call.payload);
  } catch (error) {
    if (claimKey) {
      // Release the claim so redelivery of this dispatchId can retry the send.
      await releaseRedisKey(redis, claimKey).catch((releaseError) =>
        logger.warn("dispatch_claim_release_failed", {
          key: claimKey,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError)
        })
      );
    }
    logger.error(adapterCallStarted ? "outbound_adapter_failed" : "outbound_send_failed", {
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
    payload: persistedPayload
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

/**
 * Builds and enqueues a MediaFetchRequested outbox row for inbound media. Idempotent
 * downstream (media.ts's upsertPending short-circuits by media id), so calling this more
 * than once for the same media is always safe. Shared by handleInbound's main path and its
 * replay-guard skip branch, which re-enqueues when a prior run committed the message but
 * then failed to enqueue the media fetch (self-healing an otherwise-permanent orphaned-media
 * window — see the skip branch for details).
 */
async function defaultEnqueueMediaFetch(
  channel: { tenantId: string; channelId: string },
  phoneNumberId: string | undefined,
  conversationId: string,
  messageId: string,
  media: { id: string; mimeType?: string; sha256?: string; filename?: string }
): Promise<void> {
  await withTenant(channel.tenantId, async (client) => {
    await outboxRepository.enqueue(client, channel.tenantId, {
      topic: EventTopics.MediaFetchRequested,
      payload: {
        tenantId: channel.tenantId,
        channelId: channel.channelId,
        phoneNumberId,
        conversationId,
        messageId,
        mediaId: media.id,
        mimeType: media.mimeType,
        filename: media.filename,
        sha256: media.sha256
      } satisfies MediaFetchRequest
    });
  });
}
/** Overridable via WorkerDeps (see registerWorkerConsumers) so tests can avoid touching Postgres. */
let enqueueMediaFetch: typeof defaultEnqueueMediaFetch = defaultEnqueueMediaFetch;

async function handleInbound(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", { topic: EventTopics.WhatsAppInboundReceived });
  const inbound = event.payload as InboundEvent;
  if (!inbound.phoneNumberId || !inbound.from) {
    return;
  }
  const channel = await resolveChannel(inbound.phoneNumberId);
  if (!channel) {
    logger.warn("inbound_unroutable", { phoneNumberId: inbound.phoneNumberId });
    return;
  }

  // Replay guard: a redelivered outbox row is re-published with a NEW envelope id, so
  // event.id-keyed dedupe wouldn't catch it. Skip if we've already recorded this exact
  // WhatsApp message — prevents both a duplicate message row and a duplicate auto-reply.
  if (inbound.messageId) {
    const existing = await messageRepository.findByExternalId(channel.tenantId, inbound.messageId);
    if (existing) {
      logger.info("inbound_replay_skipped", { tenantId: channel.tenantId, messageId: inbound.messageId });
      // Self-healing: a prior run may have committed the message row but then failed to
      // enqueue the media fetch (separate transaction; a transient DB error between the two
      // leaves the media permanently orphaned, since replays never reach the main path below).
      // Re-enqueue unless it's already linked — idempotent downstream, so this is harmless even
      // if the original enqueue actually succeeded. No extra DB reads when there's no media.
      const replayMedia = inbound.media as
        | { id?: string; mimeType?: string; sha256?: string; filename?: string }
        | undefined;
      const replayMediaId = replayMedia?.id;
      if (replayMediaId && !existing.payload?.mediaAsset) {
        await enqueueMediaFetch(channel, inbound.phoneNumberId, existing.conversationId, existing.id, {
          id: replayMediaId,
          mimeType: replayMedia?.mimeType,
          filename: replayMedia?.filename,
          sha256: replayMedia?.sha256
        });
        logger.info("media_fetch_reenqueued_on_replay", {
          tenantId: channel.tenantId,
          conversationId: existing.conversationId,
          messageId: existing.id,
          mediaId: replayMediaId
        });
      }
      return;
    }
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
  const createdMessage = await messageRepository.create(channel.tenantId, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    externalMessageId: inbound.messageId,
    payload
  });
  logger.info("inbound_recorded", { tenantId: channel.tenantId, messageId: inbound.messageId, type: inbound.type });

  // Inbound media (image/video/audio/document/sticker): enqueue an async fetch of the
  // bytes via the outbox. Idempotent by media id (see media.ts's upsertPending
  // short-circuit), so redelivery of this outbox row or a future replay is safe.
  const media = inbound.media as { id?: string; mimeType?: string; sha256?: string; filename?: string } | undefined;
  const mediaId = media?.id;
  if (mediaId) {
    await enqueueMediaFetch(channel, inbound.phoneNumberId, conversation.id, createdMessage.id, {
      id: mediaId,
      mimeType: media?.mimeType,
      filename: media?.filename,
      sha256: media?.sha256
    });
    logger.info("media_fetch_enqueued", {
      tenantId: channel.tenantId,
      conversationId: conversation.id,
      mediaId
    });
  }

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

  // Default automations (G8): welcome on first contact, out-of-office outside
  // working hours. Any real message type counts — a voice note deserves a
  // welcome as much as text — but reactions are not a contact reaching out.
  if (inbound.type !== "reaction") {
    // Stop-on-reply (G7): a human reply supersedes any drip in flight. Never
    // allowed to break inbound processing.
    try {
      const stopped = await sequenceRepository.stopActiveForContact(channel.tenantId, contact.id, "replied");
      if (stopped > 0) {
        incCounter("sequence_enrollments_stopped_total", "Drip enrollments stopped by an inbound reply.", {});
        logger.info("sequence_stopped_on_reply", { tenantId: channel.tenantId, contactId: contact.id, stopped });
      }
    } catch (error) {
      logger.error("sequence_stop_on_reply_failed", {
        tenantId: channel.tenantId,
        contactId: contact.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await runDefaultAutomations(channel, conversation.id, contact, createdMessage.id);
    // Round-robin auto-assignment (G9): only unassigned conversations — a
    // manual assignment or an earlier rotation is never overridden.
    if (!conversation.assignedUserId) {
      await runRoundRobinAssignment(channel.tenantId, conversation.id);
    }
  }

  // Auto-reply evaluation (only text/button messages; skip reactions, read receipts).
  if (inbound.type === "text" || inbound.type === "button" || inbound.type === "interactive") {
    const interactivePayload = inbound.interactive as
      | { button_reply?: { title?: string }; list_reply?: { title?: string } }
      | undefined;
    const interactiveTitle = interactivePayload?.button_reply?.title ?? interactivePayload?.list_reply?.title;
    const text = typeof inbound.text === "string" && inbound.text ? inbound.text : interactiveTitle;

    // Chatbot flows (G14): an active session (or a matching trigger) consumes
    // the message — keyword auto-replies are then skipped so the bot never
    // double-replies. Rule-based automations (tagging etc.) still run below.
    const flowConsumed = await runFlowRuntime(channel, conversation.id, contact, text);
    if (flowConsumed) {
      await runNewMessageAutomation(channel.tenantId, conversation.id, contact, channel.channelId, text);
      return;
    }

    const rules = await autoReplyRuleRepository.listEnabled(channel.tenantId);
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
            text: matched.replyText,
            dispatchId: randomUUID()
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

/**
 * Welcome / out-of-office default automations (G8). Failures never break
 * inbound processing; the OOO reply is suppressed per conversation for the
 * configured window via a Redis claim — when the claim cannot be evaluated
 * (Redis down) we skip rather than risk an OOO reply on every message.
 */
async function runDefaultAutomations(
  channel: { tenantId: string; channelId: string },
  conversationId: string,
  contact: { id: string; phoneE164: string },
  messageId: string
): Promise<void> {
  try {
    const settings = await automationSettingsRepository.get(channel.tenantId);
    if (!settings || (!settings.welcomeEnabled && !settings.oooEnabled)) {
      return;
    }
    const firstInbound = settings.welcomeEnabled
      ? !(await messageRepository.hasPriorInbound(channel.tenantId, conversationId, messageId))
      : false;
    const decision = decideDefaultAutomation({ settings, firstInbound, now: new Date() });
    if (!decision) {
      return;
    }
    if (decision.kind === "ooo") {
      const claimed = await claimRedisKey(
        redis,
        `ooo:${channel.tenantId}:${conversationId}`,
        settings.oooSuppressHours * 3600
      ).catch(() => false);
      if (!claimed) {
        return;
      }
    }
    await withTenant(channel.tenantId, async (client) => {
      await outboxRepository.enqueue(client, channel.tenantId, {
        topic: EventTopics.WhatsAppOutboundRequested,
        payload: {
          tenantId: channel.tenantId,
          channelId: channel.channelId,
          conversationId,
          contactPhoneE164: contact.phoneE164,
          kind: "text",
          text: decision.text,
          dispatchId: randomUUID()
        } satisfies WhatsAppOutboundRequest
      });
    });
    incCounter("default_automations_sent_total", "Welcome/OOO default automations enqueued.", {
      kind: decision.kind
    });
    logger.info("default_automation_enqueued", {
      tenantId: channel.tenantId,
      conversationId,
      kind: decision.kind
    });
  } catch (error) {
    logger.error("default_automation_failed", {
      tenantId: channel.tenantId,
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Round-robin auto-assignment (G9): rotate unassigned new conversations among
 * the configured team's active members. Failures never break inbound
 * processing; enabled-without-team is a deliberate no-op (G8's
 * OOO-without-hours precedent).
 */
async function runRoundRobinAssignment(tenantId: string, conversationId: string): Promise<void> {
  try {
    const settings = await automationSettingsRepository.get(tenantId);
    if (!settings?.roundRobinEnabled || !settings.roundRobinTeamId) {
      return;
    }
    const assignee = await teamRepository.nextRoundRobinAssignee(tenantId, settings.roundRobinTeamId);
    if (!assignee) {
      logger.warn("round_robin_no_active_members", { tenantId, teamId: settings.roundRobinTeamId });
      return;
    }
    await conversationRepository.assign(tenantId, conversationId, assignee.id);
    incCounter("round_robin_assignments_total", "Conversations auto-assigned by round-robin.", {});
    logger.info("round_robin_assigned", { tenantId, conversationId, userId: assignee.id });
  } catch (error) {
    logger.error("round_robin_assignment_failed", {
      tenantId,
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Chatbot flow runtime (G14): continues the conversation's active session with
 * the reply, or starts a new session when the text matches an active flow's
 * trigger keyword. Actions map onto existing primitives (outbox text sends,
 * tagging, team assignment). Returns true when a flow consumed the message.
 * Failures never break inbound processing.
 */
async function runFlowRuntime(
  channel: { tenantId: string; channelId: string },
  conversationId: string,
  contact: { id: string; phoneE164: string },
  text: string | undefined
): Promise<boolean> {
  try {
    let session = await flowRepository.activeSessionForConversation(channel.tenantId, conversationId);
    let flow;
    let reply: string | null = text ?? null;
    if (session) {
      flow = await flowRepository.getById(channel.tenantId, session.flowId);
      if (!flow || flow.status !== "active") {
        return false; // paused/deleted flow: normal automations take over
      }
    } else {
      if (!text?.trim()) {
        return false;
      }
      flow = await flowRepository.findByTrigger(channel.tenantId, text);
      if (!flow) {
        return false;
      }
      session = await flowRepository.startSession(channel.tenantId, {
        flowId: flow.id,
        conversationId,
        contactId: contact.id,
        currentNode: flow.definition.start
      });
      if (!session) {
        return false; // lost the one-active-session race
      }
      reply = null; // the trigger message starts the flow; it is not a question reply
    }

    const result = advanceFlow(flow.definition, session.currentNode, reply);
    for (const action of result.actions) {
      if (action.type === "send") {
        await withTenant(channel.tenantId, async (client) => {
          await outboxRepository.enqueue(client, channel.tenantId, {
            topic: EventTopics.WhatsAppOutboundRequested,
            payload: {
              tenantId: channel.tenantId,
              channelId: channel.channelId,
              conversationId,
              contactPhoneE164: contact.phoneE164,
              kind: "text",
              text: action.text,
              dispatchId: randomUUID()
            } satisfies WhatsAppOutboundRequest
          });
        });
      } else if (action.type === "add_tag") {
        await contactRepository.addTag(channel.tenantId, contact.id, action.tag);
      } else if (action.type === "assign_team") {
        await conversationRepository.assignTeam(channel.tenantId, conversationId, action.teamId);
      }
    }
    if (result.outcome.status === "waiting") {
      await flowRepository.updateSession(channel.tenantId, session.id, { currentNode: result.outcome.node });
    } else {
      await flowRepository.updateSession(channel.tenantId, session.id, { status: "completed" });
    }
    incCounter("flow_steps_total", "Chatbot flow advances.", { outcome: result.outcome.status });
    logger.info("flow_advanced", {
      tenantId: channel.tenantId,
      conversationId,
      flowId: flow.id,
      actions: result.actions.length,
      outcome: result.outcome.status
    });
    return true;
  } catch (error) {
    logger.error("flow_runtime_failed", {
      tenantId: channel.tenantId,
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
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
              templateLanguage: action.templateLanguage,
              dispatchId: randomUUID()
            } satisfies AutomationTemplateRequest
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

  // At-least-once delivery guard: skip if this dispatch was already processed. Prefer the
  // caller-assigned dispatchId (stable across outbox replay) over event.id, which is
  // regenerated on every republish and so wouldn't catch a replayed redelivery.
  const claimKey = `atreq:${req.dispatchId ?? event.id}`;
  const claimed = await claimRedisKey(redis, claimKey, 3600);
  if (!claimed) {
    // Skip branch stays outside the try below: a skip must not release another
    // in-flight attempt's claim.
    logger.info("automation_template_duplicate_skipped", { eventId: event.id, dispatchId: req.dispatchId });
    return;
  }

  // Everything from the successful claim through a completed send is guarded: any
  // exception here (contact lookup, consent/policy checks, channel resolution, or the
  // adapter call itself) releases the claim so a retry with the same dispatchId can
  // resend instead of being silently dropped as an "already claimed" replay. Business
  // declines (opted-out, no consent, policy-blocked, no channel) `return` rather than
  // throw, so they fall through normally and the claim is kept: a replay would decline
  // the same way deterministically, so keeping it is harmless and simpler than releasing.
  let result: { messageId?: string; accepted: boolean };
  let contact: Awaited<ReturnType<typeof contactRepository.findOrCreateByPhone>>;
  let channelId: string;
  try {
    // Resolve contact and enforce consent + policy before sending
    contact = await contactRepository.findOrCreateByPhone(req.tenantId, req.contactPhoneE164);
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
      template: {
        category: (req as any).templateCategory ?? "marketing",
        status: "approved"
      } as import("@hyfib/shared-core").Template,
      requestedCategory: ((req as any).templateCategory ?? "marketing") as import("@hyfib/shared-core").MessageCategory,
      isOptedOut: false,
      currentHourLocal: getCurrentHourInTz(contact.timezone ?? "UTC"),
      quietHours: (settings as unknown as { quietHours?: import("@hyfib/shared-core").QuietHoursConfig })?.quietHours,
      frequencyCap: undefined
    });
    if (!policyCheck.allowed) {
      logger.warn("automation_template_policy_blocked", {
        tenantId: req.tenantId,
        contactId: contact.id,
        reason: policyCheck.reason
      });
      return;
    }

    const resolvedChannelId = req.channelId ?? (await channelRepository.firstActive(req.tenantId))?.id;
    if (!resolvedChannelId) {
      logger.warn("automation_template_no_channel", { tenantId: req.tenantId });
      return;
    }
    channelId = resolvedChannelId;
    const channel = await resolveSendChannel(req.tenantId, channelId);
    result = await callMetaAdapter("/internal/v1/whatsapp/send-template", req.tenantId, {
      phoneNumberId: channel.phoneNumberId,
      to: req.contactPhoneE164,
      templateName: req.templateName,
      templateLanguage: req.templateLanguage,
      parameters: [],
      accessToken: channel.accessToken
    });
  } catch (error) {
    // Release the claim so redelivery of this dispatch can retry the send.
    await releaseRedisKey(redis, claimKey).catch((releaseError) =>
      logger.warn("dispatch_claim_release_failed", {
        key: claimKey,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError)
      })
    );
    logger.error("automation_template_send_failed", {
      tenantId: req.tenantId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error; // Re-throw so the broker can retry.
  }
  const conversation = await conversationRepository.findOrCreate(req.tenantId, contact.id, channelId);
  await messageRepository.create(req.tenantId, {
    conversationId: conversation.id,
    direction: "outbound",
    status: result.accepted ? "sent" : "queued",
    category: "marketing" as MessageCategory,
    externalMessageId: result.messageId,
    payload: { source: "automation", templateName: req.templateName }
  });
  logger.info("automation_template_sent", {
    tenantId: req.tenantId,
    contactPhoneE164: req.contactPhoneE164,
    externalMessageId: result.messageId
  });
  incCounter("automation_template_sends_total", "Automation template sends.", {
    result: result.accepted ? "accepted" : "queued"
  });
}

/**
 * Downloads and stores an inbound media asset (see media.ts for the flow).
 * No dispatchId/claim needed here — processMediaFetch is idempotent by media
 * id, and failures rethrow so the outbox's backoff/dead-letter is the retry
 * engine.
 */
async function handleMediaFetch(event: EventEnvelope): Promise<void> {
  incCounter("events_consumed_total", "Events consumed from the bus.", { topic: EventTopics.MediaFetchRequested });
  const req = event.payload as MediaFetchRequest;
  if (!req.tenantId || !req.channelId || !req.conversationId || !req.messageId || !req.mediaId) {
    logger.warn("media_fetch_invalid_request", { eventId: event.id });
    return;
  }
  await processMediaFetch(req, {
    media: mediaRepository,
    messages: {
      mergePayloadById: (tenantId, messageId, patch) => messageRepository.mergePayloadById(tenantId, messageId, patch)
    },
    resolveChannel: resolveSendChannel,
    fetchMedia: (mediaId, tenantId, accessToken) => metaClient.fetchMedia(mediaId, tenantId, accessToken),
    publish: (topic, payload, tenantId) => eventBus.publish(topic, payload, tenantId),
    logger
  });
}

export interface WorkerDeps {
  /** Shared in-process event bus (app-server). Falls back to the worker's own. */
  eventBus?: EventBus;
  /** Direct in-process meta transport (app-server). Falls back to HTTP fetch. */
  metaClient?: WorkerMetaClient;
  /** Redis client used by replay-claim guards (app-server may share one client). Falls back to the shared client. */
  redis?: ReturnType<typeof getRedisClient>;
  /** Phone-number-id → tenant/channel lookup. Falls back to the DB-backed resolver. */
  resolveChannel?: typeof resolveChannelByPhoneNumberId;
  /** Media-fetch outbox enqueue. Falls back to the DB-backed withTenant/outboxRepository path. */
  enqueueMediaFetch?: typeof defaultEnqueueMediaFetch;
}

/**
 * Register all worker consumers on the (possibly shared) event bus. In the
 * monolith app-server passes its shared bus + a direct meta client so the
 * worker consumes gateway-published events in-process.
 *
 * Durability: campaign runs and outbound sends are enqueued to the DB outbox by
 * the gateway; the gateway's outbox relay (started by app-server) re-publishes
 * unprocessed rows after a crash. Re-processing is safe because
 * claimPendingBatch will not hand out an already-claimed recipient and
 * campaignSendLog.tryClaim is the exactly-once guard at send time — so no
 * separate resume sweep is needed here.
 *
 * Caveat worth knowing before changing this: the in-memory bus awaits handler
 * completion and the relay publishes sequentially, so a long campaign fan-out
 * blocks the outbox relay for its whole duration. Pacing happens inside the
 * fan-out loop, so that duration scales with the recipient count.
 */
export function registerWorkerConsumers(deps: WorkerDeps = {}): void {
  if (deps.eventBus) {
    eventBus = deps.eventBus;
  }
  if (deps.metaClient) {
    metaClient = deps.metaClient;
  }
  if (deps.redis) {
    redis = deps.redis;
  }
  if (deps.resolveChannel) {
    resolveChannel = deps.resolveChannel;
  }
  if (deps.enqueueMediaFetch) {
    enqueueMediaFetch = deps.enqueueMediaFetch;
  }
  eventBus.subscribe(EventTopics.CampaignDispatchRequested, "campaign-dispatch", handleDispatch);
  eventBus.subscribe(EventTopics.CampaignDispatchResult, "campaign-results", handleDispatchResult);
  eventBus.subscribe(EventTopics.CampaignRunRequested, "campaign-run", handleCampaignRun);
  eventBus.subscribe(EventTopics.WhatsAppInboundReceived, "inbound-messages", handleInbound);
  eventBus.subscribe(EventTopics.WhatsAppStatusUpdated, "status-updates", handleStatus);
  eventBus.subscribe(EventTopics.WhatsAppOutboundRequested, "outbound-messages", handleOutbound);
  eventBus.subscribe(EventTopics.AutomationTemplateRequested, "automation-templates", handleAutomationTemplate);
  eventBus.subscribe(EventTopics.MediaFetchRequested, "media-fetch", handleMediaFetch);
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
