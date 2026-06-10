import type { WhatsAppOutboundRequest } from "@hyfib/shared-core";

export interface SendChannel {
  phoneNumberId: string;
  accessToken?: string;
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
