import type { MessageCategory, Template } from "@hyfib/shared-core";

export interface FrequencyCap {
  maxMessages: number;
  periodHours: number;
  sentInPeriod: number;
}

export interface QuietHours {
  startHour: number;
  endHour: number;
}

export interface OutboundPolicyContext {
  hasActiveConsent: boolean;
  isInside24hWindow: boolean;
  template: Template;
  requestedCategory: MessageCategory;
  isOptedOut: boolean;
  currentHourLocal: number;
  quietHours?: QuietHours;
  frequencyCap?: FrequencyCap;
  countryBlocked?: boolean;
}

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateOutboundPolicy(context: OutboundPolicyContext): PolicyResult {
  if (context.isOptedOut) {
    return { allowed: false, reason: "Contact is opted out" };
  }

  if (!context.hasActiveConsent) {
    return { allowed: false, reason: "Missing active opt-in consent" };
  }

  if (context.countryBlocked) {
    return { allowed: false, reason: "Country routing policy blocked" };
  }

  if (!context.isInside24hWindow && context.template.status !== "approved") {
    return { allowed: false, reason: "Template is not approved for business-initiated message" };
  }

  if (context.template.category !== context.requestedCategory) {
    return { allowed: false, reason: "Template category mismatch" };
  }

  if (context.quietHours && isInsideQuietHours(context.currentHourLocal, context.quietHours)) {
    return { allowed: false, reason: "Quiet hours policy violation" };
  }

  if (context.frequencyCap && context.frequencyCap.sentInPeriod >= context.frequencyCap.maxMessages) {
    return {
      allowed: false,
      reason: `Frequency cap exceeded (${context.frequencyCap.maxMessages} per ${context.frequencyCap.periodHours}h)`
    };
  }

  return { allowed: true };
}

export function isInsideQuietHours(hour: number, quietHours: QuietHours): boolean {
  const { startHour, endHour } = quietHours;
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}
