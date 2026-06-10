import type {
  TemplateComponent,
  WhatsAppInteractiveSendRequest,
  WhatsAppMediaSendRequest,
  WhatsAppTextSendRequest
} from "@hyfib/shared-core";

/**
 * Pure builders that translate our internal send requests into Meta Graph API
 * `/{phoneNumberId}/messages` request bodies. Kept free of I/O so they can be
 * unit-tested without a network or live WABA.
 */

export interface TemplateBuildInput {
  to: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
  components?: TemplateComponent[];
}

export function buildTemplateBody(input: TemplateBuildInput): Record<string, unknown> {
  // Structured components win; otherwise fall back to a single positional body component.
  const components =
    input.components && input.components.length > 0
      ? input.components
      : input.parameters.length > 0
        ? [
            {
              type: "body",
              parameters: input.parameters.map((text) => ({ type: "text", text }))
            }
          ]
        : undefined;

  return {
    messaging_product: "whatsapp",
    to: input.to,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.templateLanguage },
      ...(components ? { components } : {})
    }
  };
}

export function buildTextBody(
  input: Pick<WhatsAppTextSendRequest, "to" | "text" | "previewUrl">
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "text",
    text: {
      body: input.text,
      preview_url: input.previewUrl ?? false
    }
  };
}

export function buildMediaBody(
  input: Pick<WhatsAppMediaSendRequest, "to" | "mediaType" | "link" | "mediaId" | "caption" | "filename">
): Record<string, unknown> {
  const media: Record<string, unknown> = {};
  if (input.mediaId) {
    media.id = input.mediaId;
  } else if (input.link) {
    media.link = input.link;
  }
  // Captions apply to image/video/document; filename only to document.
  if (input.caption && input.mediaType !== "audio" && input.mediaType !== "sticker") {
    media.caption = input.caption;
  }
  if (input.filename && input.mediaType === "document") {
    media.filename = input.filename;
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: input.mediaType,
    [input.mediaType]: media
  };
}

export function buildInteractiveBody(
  input: Pick<
    WhatsAppInteractiveSendRequest,
    "to" | "interactiveType" | "bodyText" | "headerText" | "footerText" | "buttons" | "buttonLabel" | "sections"
  >
): Record<string, unknown> {
  const interactive: Record<string, unknown> = {
    type: input.interactiveType,
    body: { text: input.bodyText }
  };
  if (input.headerText) {
    interactive.header = { type: "text", text: input.headerText };
  }
  if (input.footerText) {
    interactive.footer = { text: input.footerText };
  }
  if (input.interactiveType === "button") {
    interactive.action = {
      buttons: (input.buttons ?? []).map((button) => ({
        type: "reply",
        reply: { id: button.id, title: button.title }
      }))
    };
  } else {
    interactive.action = {
      button: input.buttonLabel ?? "Select",
      sections: (input.sections ?? []).map((section) => ({
        ...(section.title ? { title: section.title } : {}),
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description ? { description: row.description } : {})
        }))
      }))
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "interactive",
    interactive
  };
}

export interface MediaUploadInput {
  buffer: Buffer;
  mimeType: string;
  filename?: string;
}

/** Builds the multipart form for uploading media to `/{phoneNumberId}/media`. */
export function buildMediaUploadForm(input: MediaUploadInput): FormData {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  // Copy into a plain Uint8Array: Buffer's ArrayBufferLike backing is not a valid BlobPart.
  form.append("file", new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }), input.filename ?? "upload");
  return form;
}

export function buildMarkReadBody(messageId: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId
  };
}

/** Maps Meta's template status strings onto our local enum. */
export function mapMetaTemplateStatus(status: string | undefined): "approved" | "rejected" | "pending" | "paused" {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
    case "DISABLED":
      return "rejected";
    case "PAUSED":
      return "paused";
    default:
      return "pending";
  }
}

/** Extracts the BODY component text from a Meta template definition, if present. */
export function extractTemplateBody(components: unknown): string {
  if (!Array.isArray(components)) {
    return "";
  }
  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as { type?: string }).type === "BODY" &&
      typeof (component as { text?: string }).text === "string"
    ) {
      return (component as { text: string }).text;
    }
  }
  return "";
}
