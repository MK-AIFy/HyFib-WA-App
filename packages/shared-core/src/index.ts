export * from "./compliance.js";
export * from "./http.js";
export * from "./idempotency.js";
export * from "./logger.js";
export * from "./metrics.js";
export * from "./security.js";
export * from "./automation.js";

export type Role =
  | "platform_owner"
  | "tenant_admin"
  | "marketing_manager"
  | "sales_agent"
  | "support_agent"
  | "analyst"
  | "compliance_auditor";

export type MessageCategory = "marketing" | "utility" | "authentication" | "service";

export interface Tenant {
  id: string;
  name: string;
  slug?: string;
  status: "active" | "suspended";
  plan: "trial" | "starter" | "growth" | "enterprise";
  maxUsers: number;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: Role[];
  status: "active" | "invited" | "suspended" | "disabled";
}

export interface Team {
  id: string;
  tenantId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Tag {
  id: string;
  tenantId: string;
  name: string;
  color?: string;
  createdAt: string;
}

export interface SavedReply {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface WhatsAppChannel {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: "green" | "yellow" | "red" | "unknown";
  status: "active" | "inactive";
  hasAccessToken?: boolean;
  createdAt: string;
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  contactId: string;
  channel: "whatsapp";
  source: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface Template {
  id: string;
  tenantId: string;
  name: string;
  category: MessageCategory;
  status: "approved" | "rejected" | "pending" | "paused";
  language: string;
  body: string;
  /** Graph template id once submitted to Meta; null for local-only drafts. */
  metaTemplateId?: string | null;
}

export interface Contact {
  id: string;
  tenantId: string;
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  optedOut: boolean;
  country?: string;
  tags: string[];
  timezone?: string;
  customFields: Record<string, string>;
}

export interface ContactNote {
  id: string;
  tenantId: string;
  contactId: string;
  authorUserId?: string;
  note: string;
  createdAt: string;
}

export interface QuietHoursConfig {
  startHour: number;
  endHour: number;
}

export interface FrequencyCapConfig {
  maxMessages: number;
  periodHours: number;
}

/** Variable mapping: key = positional index (1-based), value = contact field name or {literal:string}. */
export type VariableMapping = Record<string, string | { literal: string }>;

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  templateId: string;
  templateCategory: MessageCategory;
  status: "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled";
  createdAt: string;
  segmentId?: string;
  scheduledAt?: string;
  variableMapping?: VariableMapping;
  ratePerMinute?: number;
  quietHours?: QuietHoursConfig;
  frequencyCap?: FrequencyCapConfig;
}

export interface Segment {
  id: string;
  tenantId: string;
  name: string;
  definition: {
    tags?: string[];
    country?: string;
    hasConsent?: boolean;
    optedInOnly?: boolean;
    /**
     * Retargeting source (G6): contacts from a prior campaign's funnel.
     * statuses filters campaign_recipients.status (e.g. ["delivered"] =
     * delivered-but-not-read once "read" recipients advance); clicked
     * true/false requires/excludes a recorded shortlink click for that
     * campaign. Omitted statuses = every recipient of the campaign.
     */
    campaign?: {
      id: string;
      statuses?: string[];
      clicked?: boolean;
    };
  };
  createdAt: string;
}

export interface CampaignRecipient {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  phoneE164: string;
  status: "pending" | "policy_skipped" | "sent" | "delivered" | "read" | "failed";
  externalMessageId?: string;
  error?: string;
  skipReason?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  createdAt: string;
}

export interface AutoReplyRule {
  id: string;
  tenantId: string;
  matchType: "keyword" | "contains" | "regex" | "any";
  keyword?: string;
  replyKind: "text";
  replyText?: string;
  enabled: boolean;
  priority: number;
  createdAt: string;
}

export type AutomationTriggerType = "new_message" | "tag_added" | "conversation_assigned" | "no_reply";
export type AutomationActionType = "send_template" | "assign_agent" | "add_tag" | "create_task";

export interface AutomationConditions {
  keyword?: string;
  tag?: string;
  delayMinutes?: number;
}

export interface AutomationActionConfig {
  templateName?: string;
  templateLanguage?: string;
  assigneeUserId?: string;
  tag?: string;
  taskTitle?: string;
  dueInMinutes?: number;
}

export interface AutomationRule {
  id: string;
  tenantId: string;
  name: string;
  triggerType: AutomationTriggerType;
  conditions: AutomationConditions;
  actionType: AutomationActionType;
  actionConfig: AutomationActionConfig;
  enabled: boolean;
  priority: number;
  createdAt: string;
}

export interface Task {
  id: string;
  tenantId: string;
  title: string;
  status: "open" | "done" | "cancelled";
  contactId?: string;
  conversationId?: string;
  assigneeUserId?: string;
  dueAt?: string;
  remindAt?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  contactId: string;
  channelId: string;
  contactName?: string;
  contactPhone?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  lastInboundAt?: string;
  lastReadAt?: string;
  unreadCount: number;
  assignedUserId?: string;
  state: "open" | "pending" | "closed";
  archivedAt?: string;
  pinnedAt?: string;
}

export interface ConversationNote {
  id: string;
  tenantId: string;
  conversationId: string;
  authorUserId?: string;
  note: string;
  createdAt: string;
}

export interface WhatsAppSettings {
  id: string;
  tenantId: string;
  statusCallbackUrl?: string;
  graphVersion: string;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  outboundRateLimitPerMinute?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  category?: MessageCategory;
  externalMessageId?: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MessageSearchResult {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  status: Message["status"];
  createdAt: string;
  text: string;
  contactName?: string;
  contactPhone?: string;
}

export interface Order {
  id: string;
  tenantId: string;
  contactId: string;
  externalOrderId: string;
  amountMinor: number;
  currency: string;
  status: "created" | "confirmed" | "paid" | "cancelled";
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId?: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EventEnvelope<TPayload = unknown> {
  id: string;
  topic: string;
  occurredAt: string;
  tenantId?: string;
  payload: TPayload;
}

export interface CampaignDispatchRequest {
  campaignId: string;
  tenantId: string;
  channelId: string;
  templateName: string;
  templateLanguage: string;
  templateCategory: MessageCategory;
  contactPhoneE164: string;
  parameters: string[];
  /** Set when dispatched as part of a fan-out run; tracks funnel row. */
  recipientId?: string;
  /**
   * The campaign's send budget, carried so the dispatch can enforce a hard cap
   * without sleeping. Absent on single-number test sends, which are one-off
   * operator actions rather than paced fan-out work.
   */
  ratePerMinute?: number;
}

/** Triggers a full audience fan-out from the notification worker. */
export interface CampaignRunRequest {
  campaignId: string;
  tenantId: string;
  channelId: string;
  templateName: string;
  templateLanguage: string;
  templateCategory: MessageCategory;
  templateStatus: string;
  variableMapping?: VariableMapping;
  quietHours?: QuietHoursConfig;
  frequencyCap?: FrequencyCapConfig;
  ratePerMinute?: number;
}

export interface CampaignDispatchResult {
  campaignId: string;
  tenantId: string;
  externalMessageId?: string;
  status: "queued" | "sent" | "failed";
  error?: string;
}

export interface WebhookIngestRequest {
  rawBody: string;
  signature?: string;
}

/**
 * A structured WhatsApp template component (header/body/button). When omitted,
 * the meta-adapter falls back to building a single body component from the
 * positional `parameters` array for backward compatibility.
 */
export interface TemplateParameter {
  type: "text" | "currency" | "date_time" | "image" | "document" | "video" | "payload";
  text?: string;
  payload?: string;
  currency?: { fallback_value: string; code: string; amount_1000: number };
  date_time?: { fallback_value: string };
  image?: { link?: string; id?: string };
  document?: { link?: string; id?: string; filename?: string };
  video?: { link?: string; id?: string };
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "url" | "quick_reply";
  index?: number;
  parameters: TemplateParameter[];
}

export interface WhatsAppSendRequest {
  phoneNumberId: string;
  to: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
  /** Optional structured components; when present they replace the positional body params. */
  components?: TemplateComponent[];
  /** Optional per-tenant access token; falls back to the env token when absent. */
  accessToken?: string;
}

export type WhatsAppMediaKind = "image" | "video" | "audio" | "document" | "sticker";

/** WhatsApp catalog/product message (Commerce API). */
export interface WhatsAppProductSendRequest {
  phoneNumberId: string;
  to: string;
  /** Meta catalog ID. */
  catalogId: string;
  /** Single product SKU (send-product) or undefined (multi-product/catalog). */
  productRetailerId?: string;
  /** Sections of products for multi-product messages. */
  sections?: Array<{ title: string; productItems: Array<{ productRetailerId: string }> }>;
  bodyText?: string;
  footerText?: string;
  headerText?: string;
  accessToken?: string;
}

/** WhatsApp Flow message (interactive flow type). */
export interface WhatsAppFlowSendRequest {
  phoneNumberId: string;
  to: string;
  flowId: string;
  flowToken: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  ctaButtonText: string;
  mode?: "draft" | "published";
  accessToken?: string;
}

export interface WhatsAppTextSendRequest {
  phoneNumberId: string;
  to: string;
  text: string;
  previewUrl?: boolean;
  accessToken?: string;
}

export interface WhatsAppMediaSendRequest {
  phoneNumberId: string;
  to: string;
  mediaType: WhatsAppMediaKind;
  link?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
  accessToken?: string;
}

export interface WhatsAppInteractiveButton {
  id: string;
  title: string;
}

export interface WhatsAppInteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppInteractiveSendRequest {
  phoneNumberId: string;
  to: string;
  interactiveType: "button" | "list" | "cta_url";
  bodyText: string;
  headerText?: string;
  footerText?: string;
  /** For interactiveType "button". */
  buttons?: WhatsAppInteractiveButton[];
  /** For interactiveType "list". */
  buttonLabel?: string;
  sections?: Array<{ title?: string; rows: WhatsAppInteractiveRow[] }>;
  /** For interactiveType "cta_url": the button's visible label. */
  ctaDisplayText?: string;
  /** For interactiveType "cta_url": the URL opened when the button is tapped. */
  ctaUrl?: string;
  accessToken?: string;
}

/**
 * The caller-supplied portion of an interactive send: everything except the
 * routing fields (`phoneNumberId`/`to`) and credentials, which the worker
 * resolves from the channel at send time.
 */
export type WhatsAppInteractivePayload = Omit<WhatsAppInteractiveSendRequest, "phoneNumberId" | "to" | "accessToken">;

/** WhatsApp location message. */
export interface WhatsAppLocationSendRequest {
  phoneNumberId: string;
  to: string;
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  accessToken?: string;
}

export interface WhatsAppContactCard {
  name: { formattedName: string; firstName?: string; lastName?: string };
  phones?: Array<{ phone: string; type?: string }>;
  emails?: Array<{ email: string; type?: string }>;
}

/** WhatsApp contacts message — shares one or more vCard-style contact cards. */
export interface WhatsAppContactsSendRequest {
  phoneNumberId: string;
  to: string;
  contacts: WhatsAppContactCard[];
  accessToken?: string;
}

export interface WhatsAppMarkReadRequest {
  phoneNumberId: string;
  messageId: string;
  accessToken?: string;
}

export interface WhatsAppSendResult {
  messageId?: string;
  status: "accepted" | "failed";
  error?: string;
}

/** A WhatsApp message template as returned by Meta's message_templates endpoint. */
export interface MetaTemplateSummary {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
  /** Meta's Graph template id, when the fields list requested it. */
  metaTemplateId?: string;
}

/**
 * Durable request to send an outbound session (non-template) message, enqueued
 * by the gateway and consumed by the worker. Used for agent replies.
 */
export interface WhatsAppOutboundRequest {
  tenantId: string;
  channelId: string;
  conversationId: string;
  contactPhoneE164: string;
  kind: "text" | "media" | "interactive" | "product" | "catalog" | "flow" | "template" | "location" | "contacts";
  text?: string;
  previewUrl?: boolean;
  media?: { mediaType: WhatsAppMediaKind; link?: string; mediaId?: string; caption?: string; filename?: string };
  interactive?: WhatsAppInteractivePayload;
  template?: {
    templateName: string;
    templateLanguage: string;
    parameters?: string[];
    components?: TemplateComponent[];
  };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: WhatsAppContactCard[];
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
  actorId?: string;
  /**
   * Caller-assigned idempotency key, stable across outbox replay (unlike the
   * envelope's event.id, which is regenerated on every republish). When set, the
   * worker claims it before sending so a replayed outbox row can't double-send.
   */
  dispatchId?: string;
}

export const EventTopics = {
  WhatsAppInboundReceived: "whatsapp.inbound.received",
  WhatsAppStatusUpdated: "whatsapp.status.updated",
  WhatsAppOutboundRequested: "whatsapp.outbound.requested",
  TemplateStatusUpdated: "template.status.updated",
  CampaignDispatchRequested: "campaign.dispatch.requested",
  CampaignDispatchResult: "campaign.dispatch.result",
  CampaignRunRequested: "campaign.run.requested",
  AutomationTemplateRequested: "automation.template.requested",
  CommerceOrderEvent: "commerce.order.event",
  ComplianceOptOutEvent: "compliance.optout.event",
  AuditEventRecorded: "audit.event.recorded",
  MediaFetchRequested: "media.fetch.requested",
  MediaStored: "media.stored"
} as const;

export type EventTopic = (typeof EventTopics)[keyof typeof EventTopics];

/** Fire-and-forget template send requested by an automation rule action. */
export interface AutomationTemplateRequest {
  tenantId: string;
  /** Optional sending channel; the worker falls back to the tenant's first active channel. */
  channelId?: string;
  contactPhoneE164: string;
  templateName: string;
  templateLanguage: string;
  /** Caller-assigned idempotency key, stable across outbox replay. See WhatsAppOutboundRequest.dispatchId. */
  dispatchId?: string;
}

/**
 * Requests that the Meta media adapter fetch an inbound media asset's bytes
 * and persist them. Enqueued when a webhook message carries a media id;
 * consumed by the notification-worker media consumer (later task).
 */
export interface MediaFetchRequest {
  tenantId: string;
  channelId: string;
  phoneNumberId?: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
  mimeType?: string;
  filename?: string;
  sha256?: string;
}
