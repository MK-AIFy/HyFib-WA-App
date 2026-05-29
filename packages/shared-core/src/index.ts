export * from "./compliance.js";
export * from "./http.js";
export * from "./idempotency.js";
export * from "./logger.js";
export * from "./metrics.js";
export * from "./security.js";

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
  status: "active" | "suspended";
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: Role[];
  status: "active" | "disabled";
}

export interface WhatsAppChannel {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: "green" | "yellow" | "red" | "unknown";
  status: "active" | "inactive";
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
}

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  templateId: string;
  templateCategory: MessageCategory;
  status: "draft" | "scheduled" | "running" | "paused" | "completed";
  createdAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  contactId: string;
  channelId: string;
  lastMessageAt?: string;
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
  interactiveType: "button" | "list";
  bodyText: string;
  headerText?: string;
  footerText?: string;
  /** For interactiveType "button". */
  buttons?: WhatsAppInteractiveButton[];
  /** For interactiveType "list". */
  buttonLabel?: string;
  sections?: Array<{ title?: string; rows: WhatsAppInteractiveRow[] }>;
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
  kind: "text" | "media" | "interactive";
  text?: string;
  previewUrl?: boolean;
  media?: { mediaType: WhatsAppMediaKind; link?: string; mediaId?: string; caption?: string; filename?: string };
  actorId?: string;
}

export const EventTopics = {
  WhatsAppInboundReceived: "whatsapp.inbound.received",
  WhatsAppStatusUpdated: "whatsapp.status.updated",
  WhatsAppOutboundRequested: "whatsapp.outbound.requested",
  TemplateStatusUpdated: "template.status.updated",
  CampaignDispatchRequested: "campaign.dispatch.requested",
  CampaignDispatchResult: "campaign.dispatch.result",
  CommerceOrderEvent: "commerce.order.event",
  ComplianceOptOutEvent: "compliance.optout.event"
} as const;

export type EventTopic = (typeof EventTopics)[keyof typeof EventTopics];
