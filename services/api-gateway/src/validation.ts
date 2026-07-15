import type { TemplateComponent, WhatsAppInteractivePayload } from "@hyfib/shared-core";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ContactListQuery {
  query?: string;
  tag?: string;
  optedOut?: boolean;
  limit: number;
  offset: number;
}

const CONTACT_LIST_DEFAULT_LIMIT = 25;
const CONTACT_LIST_MAX_LIMIT = 100;

/** Parses and clamps the contact-list query params (search/filter/pagination). */
export function parseContactListQuery(params: URLSearchParams): ContactListQuery {
  const rawLimit = Number(params.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), CONTACT_LIST_MAX_LIMIT)
      : CONTACT_LIST_DEFAULT_LIMIT;
  const rawOffset = Number(params.get("offset"));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const query = params.get("q")?.trim() || undefined;
  const tag = params.get("tag")?.trim() || undefined;
  const optedOutRaw = params.get("optedOut");
  const optedOut = optedOutRaw === null || optedOutRaw.trim() === "" ? undefined : optedOutRaw === "true";
  return { query, tag, optedOut, limit, offset };
}

/** Trims and enforces a max length on a required text field. */
export function boundedText(value: unknown, max: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "value is required" };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return { ok: false, error: `value must be at most ${max} characters` };
  }
  return { ok: true, value: trimmed };
}

/** Validates an optional ISO-8601 date string; returns normalized ISO or an error. */
export function parseOptionalIsoDate(
  value: unknown
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "date must be an ISO-8601 string" };
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "date must be a valid ISO-8601 string" };
  }
  return { ok: true, value: new Date(ts).toISOString() };
}

/** Clamps an optional integer into [min, max]; returns fallback when absent/invalid. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

export interface ListQuery {
  limit: number;
  offset: number;
}

/** Parses and clamps generic limit/offset list pagination params. */
export function parseListQuery(params: URLSearchParams, defaultLimit = 25, maxLimit = 100): ListQuery {
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), maxLimit) : defaultLimit;
  const rawOffset = Number(params.get("offset"));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

// Meta Cloud API limits for interactive messages.
const BODY_TEXT_MAX = 1024;
const HEADER_TEXT_MAX = 60;
const FOOTER_TEXT_MAX = 60;
const BUTTON_ID_MAX = 256;
const BUTTON_TITLE_MAX = 20;
const BUTTONS_MAX = 3;
const LIST_BUTTON_LABEL_MAX = 20;
const SECTIONS_MAX = 10;
const SECTION_TITLE_MAX = 24;
const ROW_ID_MAX = 200;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;
const TOTAL_ROWS_MAX = 10;
const CTA_DISPLAY_TEXT_MAX = 20;
const CTA_URL_MAX = 2048;

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function optionalString(value: unknown, max: number, field: string): { value?: string; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (!isNonEmptyString(value, max)) {
    return { error: `${field} must be a non-empty string of at most ${max} characters` };
  }
  return { value };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_PER_MINUTE_MAX = 10_000;
const FREQUENCY_CAP_MAX_MESSAGES_MAX = 1_000;
const FREQUENCY_CAP_PERIOD_HOURS_MAX = 168;

export interface CampaignBodyInput {
  segmentId?: unknown;
  ratePerMinute?: unknown;
  quietHours?: unknown;
  frequencyCap?: unknown;
}

/** Validates campaign-creation optional fields that have no other validation layer. */
export function validateCampaignBody(payload: CampaignBodyInput): { ok: true } | { ok: false; error: string } {
  if (payload.segmentId !== undefined && !UUID_RE.test(String(payload.segmentId))) {
    return { ok: false, error: "segmentId must be a valid UUID" };
  }
  if (payload.ratePerMinute !== undefined) {
    const rate = Number(payload.ratePerMinute);
    if (!Number.isInteger(rate) || rate < 1 || rate > RATE_PER_MINUTE_MAX) {
      return { ok: false, error: `ratePerMinute must be an integer between 1 and ${RATE_PER_MINUTE_MAX}` };
    }
  }
  if (payload.quietHours !== undefined) {
    if (!payload.quietHours || typeof payload.quietHours !== "object" || Array.isArray(payload.quietHours)) {
      return { ok: false, error: "quietHours must be an object with startHour and endHour" };
    }
    const qh = payload.quietHours as Record<string, unknown>;
    const sh = qh.startHour;
    const eh = qh.endHour;
    if (
      !Number.isInteger(sh) ||
      (sh as number) < 0 ||
      (sh as number) > 23 ||
      !Number.isInteger(eh) ||
      (eh as number) < 0 ||
      (eh as number) > 23
    ) {
      return { ok: false, error: "quietHours.startHour and endHour must be integers between 0 and 23" };
    }
  }
  if (payload.frequencyCap !== undefined) {
    if (!payload.frequencyCap || typeof payload.frequencyCap !== "object" || Array.isArray(payload.frequencyCap)) {
      return { ok: false, error: "frequencyCap must be an object with maxMessages and periodHours" };
    }
    const fc = payload.frequencyCap as Record<string, unknown>;
    const mm = fc.maxMessages;
    const ph = fc.periodHours;
    if (!Number.isInteger(mm) || (mm as number) < 1 || (mm as number) > FREQUENCY_CAP_MAX_MESSAGES_MAX) {
      return {
        ok: false,
        error: `frequencyCap.maxMessages must be an integer between 1 and ${FREQUENCY_CAP_MAX_MESSAGES_MAX}`
      };
    }
    if (!Number.isInteger(ph) || (ph as number) < 1 || (ph as number) > FREQUENCY_CAP_PERIOD_HOURS_MAX) {
      return {
        ok: false,
        error: `frequencyCap.periodHours must be an integer between 1 and ${FREQUENCY_CAP_PERIOD_HOURS_MAX}`
      };
    }
  }
  return { ok: true };
}

/**
 * Validates a caller-supplied interactive payload against Meta's limits and
 * returns a copy stripped of unknown fields, so caller input never reaches
 * the outbox/adapter verbatim.
 */
export function validateInteractivePayload(input: unknown): ValidationResult<WhatsAppInteractivePayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interactive must be an object" };
  }
  const candidate = input as Record<string, unknown>;

  if (
    candidate.interactiveType !== "button" &&
    candidate.interactiveType !== "list" &&
    candidate.interactiveType !== "cta_url"
  ) {
    return { ok: false, error: 'interactive.interactiveType must be "button", "list" or "cta_url"' };
  }
  if (!isNonEmptyString(candidate.bodyText, BODY_TEXT_MAX)) {
    return { ok: false, error: `interactive.bodyText is required (at most ${BODY_TEXT_MAX} characters)` };
  }
  const header = optionalString(candidate.headerText, HEADER_TEXT_MAX, "interactive.headerText");
  if (header.error) {
    return { ok: false, error: header.error };
  }
  const footer = optionalString(candidate.footerText, FOOTER_TEXT_MAX, "interactive.footerText");
  if (footer.error) {
    return { ok: false, error: footer.error };
  }

  const value: WhatsAppInteractivePayload = {
    interactiveType: candidate.interactiveType,
    bodyText: candidate.bodyText,
    ...(header.value !== undefined ? { headerText: header.value } : {}),
    ...(footer.value !== undefined ? { footerText: footer.value } : {})
  };

  if (candidate.interactiveType === "button") {
    const buttons = candidate.buttons;
    if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > BUTTONS_MAX) {
      return { ok: false, error: `interactive.buttons must contain 1-${BUTTONS_MAX} buttons` };
    }
    const ids = new Set<string>();
    const cleanButtons = [];
    for (const button of buttons) {
      const entry = button as Record<string, unknown>;
      if (!isNonEmptyString(entry?.id, BUTTON_ID_MAX) || !isNonEmptyString(entry?.title, BUTTON_TITLE_MAX)) {
        return {
          ok: false,
          error: `each button needs an id (≤${BUTTON_ID_MAX} chars) and a title (≤${BUTTON_TITLE_MAX} chars)`
        };
      }
      if (ids.has(entry.id as string)) {
        return { ok: false, error: "button ids must be unique" };
      }
      ids.add(entry.id as string);
      cleanButtons.push({ id: entry.id as string, title: entry.title as string });
    }
    value.buttons = cleanButtons;
    return { ok: true, value };
  }

  if (candidate.interactiveType === "cta_url") {
    if (!isNonEmptyString(candidate.ctaDisplayText, CTA_DISPLAY_TEXT_MAX)) {
      return { ok: false, error: `interactive.ctaDisplayText is required (at most ${CTA_DISPLAY_TEXT_MAX} chars)` };
    }
    if (!isNonEmptyString(candidate.ctaUrl, CTA_URL_MAX) || !/^https?:\/\//i.test(candidate.ctaUrl)) {
      return { ok: false, error: `interactive.ctaUrl must be an http(s) URL (at most ${CTA_URL_MAX} chars)` };
    }
    value.ctaDisplayText = candidate.ctaDisplayText;
    value.ctaUrl = candidate.ctaUrl;
    return { ok: true, value };
  }

  // List message.
  const label = optionalString(candidate.buttonLabel, LIST_BUTTON_LABEL_MAX, "interactive.buttonLabel");
  if (label.error) {
    return { ok: false, error: label.error };
  }
  if (label.value !== undefined) {
    value.buttonLabel = label.value;
  }
  const sections = candidate.sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > SECTIONS_MAX) {
    return { ok: false, error: `interactive.sections must contain 1-${SECTIONS_MAX} sections` };
  }
  let totalRows = 0;
  const rowIds = new Set<string>();
  const cleanSections = [];
  for (const section of sections) {
    const entry = section as Record<string, unknown>;
    const title = optionalString(entry?.title, SECTION_TITLE_MAX, "section.title");
    if (title.error) {
      return { ok: false, error: title.error };
    }
    const rows = entry?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: "each section needs at least one row" };
    }
    const cleanRows = [];
    for (const row of rows) {
      const rowEntry = row as Record<string, unknown>;
      if (!isNonEmptyString(rowEntry?.id, ROW_ID_MAX) || !isNonEmptyString(rowEntry?.title, ROW_TITLE_MAX)) {
        return {
          ok: false,
          error: `each row needs an id (≤${ROW_ID_MAX} chars) and a title (≤${ROW_TITLE_MAX} chars)`
        };
      }
      if (rowIds.has(rowEntry.id as string)) {
        return { ok: false, error: "row ids must be unique across sections" };
      }
      rowIds.add(rowEntry.id as string);
      const description = optionalString(rowEntry.description, ROW_DESCRIPTION_MAX, "row.description");
      if (description.error) {
        return { ok: false, error: description.error };
      }
      cleanRows.push({
        id: rowEntry.id as string,
        title: rowEntry.title as string,
        ...(description.value !== undefined ? { description: description.value } : {})
      });
      totalRows += 1;
    }
    cleanSections.push({ ...(title.value !== undefined ? { title: title.value } : {}), rows: cleanRows });
  }
  if (totalRows > TOTAL_ROWS_MAX) {
    return { ok: false, error: `a list message supports at most ${TOTAL_ROWS_MAX} rows in total` };
  }
  value.sections = cleanSections;
  return { ok: true, value };
}

const TEMPLATE_NAME_MAX = 512;
const TEMPLATE_LANGUAGE_MAX = 10;
const TEMPLATE_PARAMETERS_MAX = 50;
const TEMPLATE_PARAMETER_MAX = 1024;

export interface TemplateSendPayload {
  templateName: string;
  templateLanguage: string;
  parameters?: string[];
  components?: TemplateComponent[];
}

/**
 * Validates a template-send request for the agent conversation-send route.
 * Trims templateName/templateLanguage; `parameters`/`components` pass through
 * unmodified when present (`components`, if malformed, is caught downstream
 * by the meta-adapter's Graph call — this route only bounds the caller input
 * enough to prevent abuse, mirroring validateInteractivePayload).
 */
export function validateTemplatePayload(input: unknown): ValidationResult<TemplateSendPayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "template must be an object" };
  }
  const candidate = input as Record<string, unknown>;

  const nameCheck = boundedText(candidate.templateName, TEMPLATE_NAME_MAX);
  if (!nameCheck.ok) {
    return { ok: false, error: `template.templateName ${nameCheck.error}` };
  }
  const languageCheck = boundedText(candidate.templateLanguage, TEMPLATE_LANGUAGE_MAX);
  if (!languageCheck.ok) {
    return { ok: false, error: `template.templateLanguage ${languageCheck.error}` };
  }

  const value: TemplateSendPayload = {
    templateName: nameCheck.value,
    templateLanguage: languageCheck.value
  };

  if (candidate.parameters !== undefined) {
    if (!Array.isArray(candidate.parameters) || candidate.parameters.length > TEMPLATE_PARAMETERS_MAX) {
      return { ok: false, error: `template.parameters must be an array of at most ${TEMPLATE_PARAMETERS_MAX} strings` };
    }
    for (const param of candidate.parameters) {
      if (typeof param !== "string" || param.length > TEMPLATE_PARAMETER_MAX) {
        return {
          ok: false,
          error: `each template.parameters entry must be a string of at most ${TEMPLATE_PARAMETER_MAX} characters`
        };
      }
    }
    value.parameters = candidate.parameters;
  }

  if (candidate.components !== undefined) {
    value.components = candidate.components as TemplateComponent[];
  }

  return { ok: true, value };
}
