import type {
  TemplateComponent,
  WhatsAppContactCard,
  WhatsAppInteractiveSendRequest,
  WhatsAppLocationSendRequest,
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

export function buildLocationBody(
  input: Pick<WhatsAppLocationSendRequest, "to" | "latitude" | "longitude" | "name" | "address">
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "location",
    location: {
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.name ? { name: input.name } : {}),
      ...(input.address ? { address: input.address } : {})
    }
  };
}

/** Builds a `contacts`-type message body sharing one or more vCard-style contact cards. */
export function buildContactsBody(input: { to: string; contacts: WhatsAppContactCard[] }): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "contacts",
    contacts: input.contacts.map((contact) => ({
      name: {
        formatted_name: contact.name.formattedName,
        ...(contact.name.firstName ? { first_name: contact.name.firstName } : {}),
        ...(contact.name.lastName ? { last_name: contact.name.lastName } : {})
      },
      ...(contact.phones?.length
        ? { phones: contact.phones.map((p) => ({ phone: p.phone, ...(p.type ? { type: p.type } : {}) })) }
        : {}),
      ...(contact.emails?.length
        ? { emails: contact.emails.map((e) => ({ email: e.email, ...(e.type ? { type: e.type } : {}) })) }
        : {})
    }))
  };
}

export function buildInteractiveBody(
  input: Pick<
    WhatsAppInteractiveSendRequest,
    | "to"
    | "interactiveType"
    | "bodyText"
    | "headerText"
    | "footerText"
    | "buttons"
    | "buttonLabel"
    | "sections"
    | "ctaDisplayText"
    | "ctaUrl"
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
  } else if (input.interactiveType === "cta_url") {
    interactive.action = {
      name: "cta_url",
      parameters: { display_text: input.ctaDisplayText, url: input.ctaUrl }
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

export interface ProductMessageInput {
  to: string;
  catalogId: string;
  productRetailerId: string;
  bodyText?: string;
}

/** Builds a single-product (MPM) message body for the `/messages` endpoint. */
export function buildProductMessage(input: ProductMessageInput): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "interactive",
    interactive: {
      type: "product",
      body: { text: input.bodyText ?? " " },
      action: { catalog_id: input.catalogId, product_retailer_id: input.productRetailerId }
    }
  };
}

export interface ProductSection {
  title: string;
  productItems: Array<{ productRetailerId: string }>;
}

export interface CatalogMessageInput {
  to: string;
  catalogId: string;
  sections: ProductSection[];
  headerText?: string;
  bodyText?: string;
  footerText?: string;
}

/** Builds a multi-product catalog message body for the `/messages` endpoint. */
export function buildCatalogMessage(input: CatalogMessageInput): Record<string, unknown> {
  const interactive: Record<string, unknown> = {
    type: "product_list",
    body: { text: input.bodyText ?? " " },
    action: {
      catalog_id: input.catalogId,
      sections: input.sections.map((s) => ({
        title: s.title,
        product_items: s.productItems.map((p) => ({ product_retailer_id: p.productRetailerId }))
      }))
    }
  };
  if (input.headerText) {
    interactive.header = { type: "text", text: input.headerText };
  }
  if (input.footerText) {
    interactive.footer = { text: input.footerText };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "interactive",
    interactive
  };
}

export interface FlowMessageInput {
  to: string;
  flowId: string;
  flowToken: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  ctaButtonText: string;
  mode?: "draft" | "published";
}

/** Builds a WhatsApp Flow message body for the `/messages` endpoint. */
export function buildFlowMessage(input: FlowMessageInput): Record<string, unknown> {
  const interactive: Record<string, unknown> = {
    type: "flow",
    body: { text: input.bodyText },
    action: {
      name: "flow",
      parameters: {
        flow_message_version: "3",
        flow_token: input.flowToken,
        flow_id: input.flowId,
        flow_cta: input.ctaButtonText,
        flow_action: "navigate",
        ...(input.mode === "draft" ? { mode: "draft" } : {})
      }
    }
  };
  if (input.headerText) {
    interactive.header = { type: "text", text: input.headerText };
  }
  if (input.footerText) {
    interactive.footer = { text: input.footerText };
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

/**
 * Marks the referenced inbound message read and shows the typing indicator
 * to the customer. Meta only exposes typing indicators as an extension of
 * the read-receipt call — there is no standalone "start typing" endpoint.
 */
export function buildTypingIndicatorBody(messageId: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" }
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

export interface TemplateCreateInput {
  name: string;
  language: string;
  category: string;
  bodyText: string;
}

/**
 * Graph body for POST /{wabaId}/message_templates. Body-only components —
 * matches the extractTemplateBody model used on sync pulls; header/footer/
 * button components are a later iteration.
 */
export function buildTemplateCreateBody(input: TemplateCreateInput): Record<string, unknown> {
  return {
    name: input.name,
    language: input.language,
    category: input.category.toUpperCase(),
    components: [{ type: "BODY", text: input.bodyText }]
  };
}

/** Graph body for POST /{templateId} (template edit) — only provided fields. */
export function buildTemplateEditBody(input: { category?: string; bodyText?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.category !== undefined) {
    body.category = input.category.toUpperCase();
  }
  if (input.bodyText !== undefined) {
    body.components = [{ type: "BODY", text: input.bodyText }];
  }
  return body;
}
