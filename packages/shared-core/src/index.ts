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

export interface WhatsAppSendRequest {
  phoneNumberId: string;
  to: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
}

export interface WhatsAppSendResult {
  messageId?: string;
  status: "accepted" | "failed";
  error?: string;
}

export const EventTopics = {
  WhatsAppInboundReceived: "whatsapp.inbound.received",
  WhatsAppStatusUpdated: "whatsapp.status.updated",
  TemplateStatusUpdated: "template.status.updated",
  CampaignDispatchRequested: "campaign.dispatch.requested",
  CampaignDispatchResult: "campaign.dispatch.result",
  CommerceOrderEvent: "commerce.order.event",
  ComplianceOptOutEvent: "compliance.optout.event"
} as const;

export type EventTopic = (typeof EventTopics)[keyof typeof EventTopics];
