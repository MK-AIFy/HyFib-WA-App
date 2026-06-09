import type { WhatsAppInteractivePayload } from "@hyfib/shared-core";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

  if (candidate.interactiveType !== "button" && candidate.interactiveType !== "list") {
    return { ok: false, error: 'interactive.interactiveType must be "button" or "list"' };
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
