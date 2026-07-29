import { validateWorkingHours, type WorkingHours } from "@hyfib/shared-core";

/**
 * Validation for PUT /api/v1/automation-settings (roadmap G8). Pure module so
 * it is unit-testable without booting the gateway (media-upload.ts pattern).
 */

export interface AutomationSettingsPatch {
  timezone?: string;
  workingHours?: WorkingHours;
  welcomeEnabled?: boolean;
  welcomeText?: string | null;
  oooEnabled?: boolean;
  oooText?: string | null;
  oooSuppressHours?: number;
  roundRobinEnabled?: boolean;
  roundRobinTeamId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AutomationSettingsPatchResult = { ok: true; value: AutomationSettingsPatch } | { ok: false; error: string };

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function validateAutomationSettingsPatch(payload: unknown): AutomationSettingsPatchResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = payload as Record<string, unknown>;
  const value: AutomationSettingsPatch = {};

  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string" || raw.timezone.length === 0 || raw.timezone.length > 64) {
      return { ok: false, error: "timezone must be a string of at most 64 characters" };
    }
    if (!isValidTimezone(raw.timezone)) {
      return { ok: false, error: `unknown timezone "${raw.timezone}" — use an IANA zone like Asia/Kolkata` };
    }
    value.timezone = raw.timezone;
  }
  if (raw.workingHours !== undefined) {
    const hours = validateWorkingHours(raw.workingHours);
    if (!hours.ok) {
      return { ok: false, error: hours.error };
    }
    value.workingHours = hours.value;
  }
  if (raw.roundRobinTeamId !== undefined) {
    if (raw.roundRobinTeamId === null) {
      value.roundRobinTeamId = null;
    } else if (typeof raw.roundRobinTeamId === "string" && UUID_RE.test(raw.roundRobinTeamId)) {
      value.roundRobinTeamId = raw.roundRobinTeamId;
    } else {
      return { ok: false, error: "roundRobinTeamId must be a team UUID or null" };
    }
  }
  for (const field of ["welcomeEnabled", "oooEnabled", "roundRobinEnabled"] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== "boolean") {
        return { ok: false, error: `${field} must be a boolean` };
      }
      value[field] = raw[field];
    }
  }
  for (const field of ["welcomeText", "oooText"] as const) {
    const text = raw[field];
    if (text === undefined) {
      continue;
    }
    if (text === null) {
      value[field] = null;
      continue;
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, error: `${field} must be a non-empty string or null` };
    }
    if (text.length > 1024) {
      return { ok: false, error: `${field} must be at most 1024 characters` };
    }
    value[field] = text.trim();
  }
  if (raw.oooSuppressHours !== undefined) {
    if (
      typeof raw.oooSuppressHours !== "number" ||
      !Number.isInteger(raw.oooSuppressHours) ||
      raw.oooSuppressHours < 1 ||
      raw.oooSuppressHours > 168
    ) {
      return { ok: false, error: "oooSuppressHours must be an integer between 1 and 168" };
    }
    value.oooSuppressHours = raw.oooSuppressHours;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "at least one field is required" };
  }
  return { ok: true, value };
}
