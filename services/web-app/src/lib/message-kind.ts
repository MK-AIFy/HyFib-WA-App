import type { Message, WhatsAppInteractivePayload } from "@hyfib/shared-core";

/**
 * Helpers for reading a message's semantic "kind" and per-kind content out of
 * its untyped `payload` jsonb. Outbound rows carry a `kind` discriminator and
 * camelCase fields (persisted verbatim from the send request); inbound rows
 * carry Meta's `type` discriminator and, for contacts, Meta's raw snake_case
 * shape. Every reader here tolerates BOTH families and never throws on junk —
 * a message with a malformed payload degrades to the text fallback, never a
 * crash in the timeline.
 */
type Payload = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Accepts a finite number or a numeric string (inbound coords may be either). */
function finiteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Outbound `payload.kind`, else inbound Meta `payload.type`, else "text". */
export function messageKind(m: Pick<Message, "payload">): string {
  const p = m.payload as { kind?: unknown; type?: unknown };
  return str(p.kind) ?? str(p.type) ?? "text";
}

export interface LocationInfo {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** Returns location details only when both coordinates resolve to finite numbers. */
export function locationOf(payload: Payload): LocationInfo | undefined {
  const loc = payload.location;
  if (!loc || typeof loc !== "object") return undefined;
  const l = loc as Record<string, unknown>;
  const latitude = finiteNumber(l.latitude);
  const longitude = finiteNumber(l.longitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  return { latitude, longitude, name: str(l.name), address: str(l.address) };
}

export interface ContactCardInfo {
  formattedName: string;
  phones: string[];
  emails: string[];
}

function contactFieldValues(container: Record<string, unknown>, key: "phones" | "emails"): string[] {
  const arr = container[key];
  if (!Array.isArray(arr)) return [];
  const field = key === "phones" ? "phone" : "email";
  const out: string[] = [];
  for (const entry of arr) {
    if (entry && typeof entry === "object") {
      const value = str((entry as Record<string, unknown>)[field]);
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * Normalizes both outbound camelCase cards (`name.formattedName`) and inbound
 * Meta snake_case cards (`name.formatted_name`). Entries with no resolvable
 * name, phone, or email are dropped as junk.
 */
export function contactCardsOf(payload: Payload): ContactCardInfo[] {
  const raw = payload.contacts;
  if (!Array.isArray(raw)) return [];
  const cards: ContactCardInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const name = c.name && typeof c.name === "object" ? (c.name as Record<string, unknown>) : {};
    const explicitName = str(name.formattedName) ?? str(name.formatted_name);
    const phones = contactFieldValues(c, "phones");
    const emails = contactFieldValues(c, "emails");
    if (!explicitName && phones.length === 0 && emails.length === 0) continue;
    cards.push({ formattedName: explicitName ?? phones[0] ?? "Contact", phones, emails });
  }
  return cards;
}

export type InteractivePrompt = WhatsAppInteractivePayload;

/**
 * The OUTBOUND interactive prompt shape (button / list / cta_url), identified
 * by the presence of `interactiveType`. Inbound replies lack that field and
 * are handled by {@link interactiveReplyOf} instead.
 */
export function interactivePromptOf(payload: Payload): InteractivePrompt | undefined {
  const i = payload.interactive;
  if (!i || typeof i !== "object") return undefined;
  const obj = i as Record<string, unknown>;
  if (typeof obj.interactiveType !== "string") return undefined;
  return obj as unknown as InteractivePrompt;
}

export interface InteractiveReply {
  label: "Button reply" | "List reply";
  title?: string;
  description?: string;
}

/** The INBOUND interactive reply shape (`{ kind: "button_reply" | "list_reply" }`). */
export function interactiveReplyOf(payload: Payload): InteractiveReply | undefined {
  const i = payload.interactive;
  if (!i || typeof i !== "object") return undefined;
  const obj = i as Record<string, unknown>;
  if (obj.kind !== "button_reply" && obj.kind !== "list_reply") return undefined;
  return {
    label: obj.kind === "button_reply" ? "Button reply" : "List reply",
    title: str(obj.title),
    description: str(obj.description)
  };
}

export interface TemplateInfo {
  templateName: string;
  templateLanguage: string;
  parameters?: string[];
}

export function templateOf(payload: Payload): TemplateInfo | undefined {
  const t = payload.template;
  if (!t || typeof t !== "object") return undefined;
  const obj = t as Record<string, unknown>;
  const templateName = str(obj.templateName);
  if (!templateName) return undefined;
  const parameters = Array.isArray(obj.parameters)
    ? obj.parameters.filter((p): p is string => typeof p === "string")
    : undefined;
  return { templateName, templateLanguage: str(obj.templateLanguage) ?? "", parameters };
}

/**
 * Returns the URL only when it parses and uses the http(s) scheme; rejects
 * `javascript:`, `data:`, `mailto:`, relative junk, and non-strings. Callers
 * must render a link ONLY for a defined result — never trust a raw payload URL.
 */
export function safeHttpUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function mapsUrl(loc: LocationInfo): string {
  return `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
}

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/** Highest positional index used in a template body, e.g. 2 for "Hi {{1}}, order {{2}}". */
export function placeholderCount(body: string): number {
  let max = 0;
  for (const match of body.matchAll(PLACEHOLDER)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Substitutes `{{n}}` with `parameters[n-1]`; a missing/empty value leaves the literal `{{n}}`. */
export function substituteTemplate(body: string, parameters?: string[]): string {
  if (!parameters || parameters.length === 0) return body;
  return body.replace(PLACEHOLDER, (whole, digits: string) => {
    const value = parameters[Number(digits) - 1];
    return value !== undefined && value !== "" ? value : whole;
  });
}
