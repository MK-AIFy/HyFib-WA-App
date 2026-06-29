/**
 * Pure normalizers that turn raw Meta webhook `value` objects into the typed
 * events we publish on the bus. Kept I/O-free so they are unit-testable.
 */

export interface RawMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export interface RawMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  image?: RawMedia;
  video?: RawMedia;
  audio?: RawMedia;
  document?: RawMedia;
  sticker?: RawMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { emoji?: string; message_id?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  contacts?: unknown[];
  referral?: Record<string, unknown>;
  context?: { forwarded?: boolean; frequently_forwarded?: boolean; id?: string; from?: string };
}

export interface RawStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
  conversation?: { id?: string; origin?: { type?: string }; expiration_timestamp?: string };
  pricing?: { billable?: boolean; pricing_model?: string; category?: string };
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

export interface RawValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: RawMessage[];
  statuses?: RawStatus[];
}

export interface NormalizedInboundEvent {
  entryId?: string;
  phoneNumberId?: string;
  messageId?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  profileName?: string;
  /** Best-effort human-readable summary used for opt-out keyword checks and previews. */
  text?: string;
  media?: { id?: string; mimeType?: string; sha256?: string; caption?: string; filename?: string };
  interactive?: { kind: "button_reply" | "list_reply"; id?: string; title?: string; description?: string };
  button?: { payload?: string; text?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { emoji?: string; messageId?: string };
  contacts?: unknown[];
  referral?: Record<string, unknown>;
  context?: { forwarded?: boolean; referredMessageId?: string };
}

export interface NormalizedStatusEvent {
  entryId?: string;
  phoneNumberId?: string;
  messageId?: string;
  status?: string;
  recipientId?: string;
  timestamp?: string;
  pricing?: { billable?: boolean; category?: string; model?: string };
  conversation?: { id?: string; originType?: string; expiresAt?: string };
  errors: Array<{ code?: number; title?: string; message?: string }>;
}

function mapMedia(media: RawMedia | undefined): NormalizedInboundEvent["media"] | undefined {
  if (!media) {
    return undefined;
  }
  return {
    id: media.id,
    mimeType: media.mime_type,
    sha256: media.sha256,
    caption: media.caption,
    filename: media.filename
  };
}

/**
 * Builds the short text summary used for opt-out detection and conversation
 * previews across every message type (so STOP via a quick-reply still works).
 */
function deriveText(message: RawMessage): string | undefined {
  switch (message.type) {
    case "text":
      return message.text?.body;
    case "button":
      return message.button?.text ?? message.button?.payload;
    case "interactive":
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return message[message.type]?.caption;
    case "location":
      return message.location?.name ?? message.location?.address;
    case "reaction":
      return message.reaction?.emoji;
    default:
      return message.text?.body;
  }
}

export function normalizeInbound(value: RawValue, message: RawMessage, entryId?: string): NormalizedInboundEvent {
  const profileName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
  const event: NormalizedInboundEvent = {
    entryId,
    phoneNumberId: value.metadata?.phone_number_id,
    messageId: message.id,
    from: message.from ? (message.from.startsWith("+") ? message.from : `+${message.from}`) : message.from,
    type: message.type,
    timestamp: message.timestamp,
    profileName,
    text: deriveText(message)
  };

  const mediaSource = message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;
  const media = mapMedia(mediaSource);
  if (media) {
    event.media = media;
  }

  if (message.interactive?.button_reply) {
    event.interactive = {
      kind: "button_reply",
      id: message.interactive.button_reply.id,
      title: message.interactive.button_reply.title
    };
  } else if (message.interactive?.list_reply) {
    event.interactive = {
      kind: "list_reply",
      id: message.interactive.list_reply.id,
      title: message.interactive.list_reply.title,
      description: message.interactive.list_reply.description
    };
  }

  if (message.button) {
    event.button = { payload: message.button.payload, text: message.button.text };
  }
  if (message.location) {
    event.location = {
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      name: message.location.name,
      address: message.location.address
    };
  }
  if (message.reaction) {
    event.reaction = { emoji: message.reaction.emoji, messageId: message.reaction.message_id };
  }
  if (message.contacts) {
    event.contacts = message.contacts;
  }
  if (message.referral) {
    event.referral = message.referral;
  }
  if (message.context) {
    event.context = {
      forwarded: message.context.forwarded ?? message.context.frequently_forwarded,
      referredMessageId: message.context.id
    };
  }

  return event;
}

export function normalizeStatus(value: RawValue, status: RawStatus, entryId?: string): NormalizedStatusEvent {
  const event: NormalizedStatusEvent = {
    entryId,
    phoneNumberId: value.metadata?.phone_number_id,
    messageId: status.id,
    status: status.status,
    recipientId: status.recipient_id,
    timestamp: status.timestamp,
    errors: (status.errors ?? []).map((error) => ({
      code: error.code,
      title: error.title,
      message: error.message ?? error.error_data?.details
    }))
  };
  if (status.pricing) {
    event.pricing = {
      billable: status.pricing.billable,
      category: status.pricing.category,
      model: status.pricing.pricing_model
    };
  }
  if (status.conversation) {
    event.conversation = {
      id: status.conversation.id,
      originType: status.conversation.origin?.type,
      expiresAt: status.conversation.expiration_timestamp
    };
  }
  return event;
}
