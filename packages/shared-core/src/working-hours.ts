/**
 * Working-hours evaluation for the default automations (roadmap G8: welcome /
 * out-of-office). Pure and side-effect free — the worker decides whether to
 * send an OOO reply with it, and the gateway validates configs with it.
 *
 * Model: a weekly map keyed by day ("mon".."sun"). A day that is absent or
 * null is closed all day. An EMPTY config means working hours are not in use —
 * always open — so enabling OOO without configuring hours never fires it.
 * Windows are [open, close); close < open spans midnight into the next day.
 */

export interface DayHours {
  /** "HH:MM" 24h local time. */
  open: string;
  close: string;
}

export const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export type WorkingHours = Partial<Record<WeekDay, DayHours | null>>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(time: string): number {
  const match = TIME_RE.exec(time);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Local weekday + minutes-since-midnight for `now` in `timezone`, or null when the zone is invalid. */
function localParts(timezone: string, now: Date): { day: WeekDay; minutes: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const weekday = parts
      .find((p) => p.type === "weekday")
      ?.value.toLowerCase()
      .slice(0, 3);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!weekday || !WEEK_DAYS.includes(weekday as WeekDay) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    // Intl may render midnight as "24" with hour12:false in some engines.
    return { day: weekday as WeekDay, minutes: (hour % 24) * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * True when `now` falls inside the configured hours. Fails OPEN on invalid
 * config/timezone: a broken setting must never suppress replies or fire OOO
 * around the clock.
 */
export function isWithinWorkingHours(hours: WorkingHours, timezone: string, now: Date): boolean {
  if (!hours || typeof hours !== "object" || Object.keys(hours).length === 0) {
    return true;
  }
  const local = localParts(timezone, now);
  if (!local) {
    return true;
  }

  const withinDay = (day: WeekDay, minutes: number): boolean => {
    const window = hours[day];
    if (!window) return false;
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
    if (open === close) return false;
    if (close > open) {
      return minutes >= open && minutes < close;
    }
    // Overnight window: the [open, midnight) half belongs to this day.
    return minutes >= open;
  };

  if (withinDay(local.day, local.minutes)) {
    return true;
  }
  // The [midnight, close) half of the PREVIOUS day's overnight window.
  const prevDay = WEEK_DAYS[(WEEK_DAYS.indexOf(local.day) + 6) % 7]!;
  const prevWindow = hours[prevDay];
  if (prevWindow) {
    const open = toMinutes(prevWindow.open);
    const close = toMinutes(prevWindow.close);
    if (Number.isFinite(open) && Number.isFinite(close) && close < open) {
      return local.minutes < close;
    }
  }
  return false;
}

export type WorkingHoursValidation = { ok: true; value: WorkingHours } | { ok: false; error: string };

/** Structural validation for configs arriving over the API. */
export function validateWorkingHours(value: unknown): WorkingHoursValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "workingHours must be an object keyed by day (mon..sun)" };
  }
  const result: WorkingHours = {};
  for (const [key, window] of Object.entries(value)) {
    if (!WEEK_DAYS.includes(key as WeekDay)) {
      return { ok: false, error: `unknown day "${key}" — use ${WEEK_DAYS.join(", ")}` };
    }
    if (window === null) {
      result[key as WeekDay] = null;
      continue;
    }
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      return { ok: false, error: `${key} must be null (closed) or {open, close}` };
    }
    const { open, close } = window as { open?: unknown; close?: unknown };
    if (typeof open !== "string" || !TIME_RE.test(open) || typeof close !== "string" || !TIME_RE.test(close)) {
      return { ok: false, error: `${key}: open/close must be "HH:MM" 24h times` };
    }
    if (open === close) {
      return { ok: false, error: `${key}: open and close must differ (a zero-length window is closed — use null)` };
    }
    result[key as WeekDay] = { open, close };
  }
  return { ok: true, value: result };
}
