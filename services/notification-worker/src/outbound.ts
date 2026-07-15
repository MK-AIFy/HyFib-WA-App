import type { WhatsAppOutboundRequest } from "@hyfib/shared-core";

export interface SendChannel {
  phoneNumberId: string;
  accessToken?: string;
}

/** Minimal Redis surface needed for the replay-claim guard (matches ioredis). */
export interface ClaimRedis {
  set(key: string, value: string, ttlFlag: "EX", ttlSeconds: number, nxFlag: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
}

/** Prefix for outbound dispatchId replay-claim keys, mirroring the `atreq:` guard's naming style. */
export const DISPATCH_CLAIM_PREFIX = "outb:";

/** How long an outbound dispatch claim survives — long enough to outlast the outbox relay's retry/backoff window. */
export const DISPATCH_CLAIM_TTL_SECONDS = 86_400;

/** Builds the Redis key used to claim a caller-assigned dispatchId before sending. */
export function dispatchClaimKey(dispatchId: string): string {
  return `${DISPATCH_CLAIM_PREFIX}${dispatchId}`;
}

/**
 * Claims a Redis key with SET NX EX so redelivery of the same logical work (a
 * replayed outbox row gets a new envelope id, so event.id-keyed dedupe misses it)
 * can be recognized and skipped. Returns true when newly claimed, false when an
 * existing claim is already held.
 */
export async function claimRedisKey(redis: ClaimRedis, key: string, ttlSeconds: number): Promise<boolean> {
  const claimed = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return claimed !== null;
}

/** Releases a previously claimed key so a failed send can be retried on redelivery. */
export async function releaseRedisKey(redis: ClaimRedis, key: string): Promise<void> {
  await redis.del(key);
}

export interface OutboundAdapterCall {
  endpoint: string;
  payload: Record<string, unknown>;
  /** What we persist on the message row (JSONB) for history/audit. */
  persistedPayload: Record<string, unknown>;
}

/**
 * Maps an outbound session-message command onto the meta-adapter endpoint,
 * request payload and the payload persisted with the message. Pure (no I/O)
 * so each kind's wiring can be unit-tested.
 */
export function buildOutboundAdapterCall(command: WhatsAppOutboundRequest, channel: SendChannel): OutboundAdapterCall {
  if (command.kind === "template" && command.template) {
    return {
      endpoint: "/internal/v1/whatsapp/send-template",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        templateName: command.template.templateName,
        templateLanguage: command.template.templateLanguage,
        parameters: command.template.parameters ?? [],
        components: command.template.components,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "template", template: command.template, actorId: command.actorId }
    };
  }
  if (command.kind === "product" && command.product) {
    return {
      endpoint: "/internal/v1/whatsapp/send-product",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        catalogId: command.product.catalogId,
        productRetailerId: command.product.productRetailerId,
        bodyText: command.product.bodyText,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "product", product: command.product, actorId: command.actorId }
    };
  }
  if (command.kind === "catalog" && command.catalog) {
    return {
      endpoint: "/internal/v1/whatsapp/send-catalog",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        catalogId: command.catalog.catalogId,
        sections: command.catalog.sections,
        headerText: command.catalog.headerText,
        bodyText: command.catalog.bodyText,
        footerText: command.catalog.footerText,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "catalog", catalog: command.catalog, actorId: command.actorId }
    };
  }
  if (command.kind === "flow" && command.flow) {
    return {
      endpoint: "/internal/v1/whatsapp/send-flow",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        flowId: command.flow.flowId,
        flowToken: command.flow.flowToken,
        bodyText: command.flow.bodyText,
        ctaButtonText: command.flow.ctaButtonText,
        headerText: command.flow.headerText,
        footerText: command.flow.footerText,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "flow", flow: command.flow, actorId: command.actorId }
    };
  }
  if (command.kind === "interactive" && command.interactive) {
    return {
      endpoint: "/internal/v1/whatsapp/send-interactive",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        interactiveType: command.interactive.interactiveType,
        bodyText: command.interactive.bodyText,
        headerText: command.interactive.headerText,
        footerText: command.interactive.footerText,
        buttons: command.interactive.buttons,
        buttonLabel: command.interactive.buttonLabel,
        sections: command.interactive.sections,
        ctaDisplayText: command.interactive.ctaDisplayText,
        ctaUrl: command.interactive.ctaUrl,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "interactive", interactive: command.interactive, actorId: command.actorId }
    };
  }
  if (command.kind === "media" && command.media) {
    return {
      endpoint: "/internal/v1/whatsapp/send-media",
      payload: {
        phoneNumberId: channel.phoneNumberId,
        to: command.contactPhoneE164,
        mediaType: command.media.mediaType,
        link: command.media.link,
        mediaId: command.media.mediaId,
        caption: command.media.caption,
        filename: command.media.filename,
        accessToken: channel.accessToken
      },
      persistedPayload: { kind: "media", media: command.media, actorId: command.actorId }
    };
  }
  return {
    endpoint: "/internal/v1/whatsapp/send-text",
    payload: {
      phoneNumberId: channel.phoneNumberId,
      to: command.contactPhoneE164,
      text: command.text,
      previewUrl: command.previewUrl,
      accessToken: channel.accessToken
    },
    persistedPayload: { kind: "text", text: command.text, actorId: command.actorId }
  };
}
