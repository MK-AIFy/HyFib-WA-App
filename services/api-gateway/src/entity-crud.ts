/**
 * Pure validation for the entity edit/delete routes (roadmap A4/A5). PATCH
 * validators are merge-aware: cross-field rules (e.g. "keyword is required
 * unless matchType is any") must hold for the MERGED result of existing row +
 * patch, not for the patch alone — switching matchType to regex must validate
 * the keyword that will actually be in effect. Kept out of index.ts so all of
 * it is unit-testable without booting the gateway (media-upload.ts pattern).
 */

import type { AutoReplyRule, AutomationRule } from "@hyfib/shared-core";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function err(error: string): Err {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max: number): Ok<string> | Err {
  if (typeof value !== "string" || value.trim().length === 0) {
    return err(`${field} must be a non-empty string`);
  }
  if (value.length > max) {
    return err(`${field} must be at most ${max} characters`);
  }
  return { ok: true, value: value.trim() };
}

// ─── Auto-reply rules ───────────────────────────────────────────────────────

const MATCH_TYPES = new Set(["keyword", "contains", "regex", "any"]);

export interface AutoReplyRulePatch {
  matchType?: AutoReplyRule["matchType"];
  keyword?: string | null;
  replyText?: string;
  priority?: number;
  enabled?: boolean;
}

export function validateAutoReplyRulePatch(
  payload: unknown,
  existing: Pick<AutoReplyRule, "matchType" | "keyword">
): Ok<AutoReplyRulePatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: AutoReplyRulePatch = {};
  if (payload.matchType !== undefined) {
    if (typeof payload.matchType !== "string" || !MATCH_TYPES.has(payload.matchType)) {
      return err("matchType must be keyword, contains, regex, or any");
    }
    value.matchType = payload.matchType as AutoReplyRule["matchType"];
  }
  if (payload.keyword !== undefined) {
    const check = boundedString(payload.keyword, "keyword", 256);
    if (!check.ok) {
      return check;
    }
    value.keyword = check.value;
  }
  if (payload.replyText !== undefined) {
    const check = boundedString(payload.replyText, "replyText", 4096);
    if (!check.ok) {
      return check;
    }
    value.replyText = check.value;
  }
  if (payload.priority !== undefined) {
    if (typeof payload.priority !== "number" || !Number.isInteger(payload.priority)) {
      return err("priority must be an integer");
    }
    value.priority = Math.min(Math.max(payload.priority, 0), 1000);
  }
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") {
      return err("enabled must be a boolean");
    }
    value.enabled = payload.enabled;
  }
  if (Object.keys(value).length === 0) {
    return err("at least one field is required");
  }
  // Cross-field rules hold for the merged result.
  const effectiveMatchType = value.matchType ?? existing.matchType;
  const effectiveKeyword = value.keyword !== undefined ? value.keyword : (existing.keyword ?? null);
  if (effectiveMatchType === "any") {
    // Keyword is meaningless for catch-all rules; clear it on the way through.
    value.keyword = null;
  } else {
    if (!effectiveKeyword) {
      return err(`keyword is required for matchType "${effectiveMatchType}"`);
    }
    if (effectiveMatchType === "regex") {
      try {
        new RegExp(effectiveKeyword);
      } catch {
        return err("keyword is not a valid regular expression");
      }
    }
  }
  return { ok: true, value };
}

// ─── Automation rules ───────────────────────────────────────────────────────

export const AUTOMATION_TRIGGER_TYPES = new Set(["new_message", "tag_added", "conversation_assigned", "no_reply"]);
export const AUTOMATION_ACTION_TYPES = new Set(["send_template", "assign_agent", "add_tag", "create_task"]);

export interface AutomationRulePatch {
  name?: string;
  triggerType?: AutomationRule["triggerType"];
  conditions?: AutomationRule["conditions"];
  actionType?: AutomationRule["actionType"];
  actionConfig?: AutomationRule["actionConfig"];
  priority?: number;
  enabled?: boolean;
}

export function validateAutomationRulePatch(
  payload: unknown,
  existing: Pick<AutomationRule, "actionType" | "actionConfig">
): Ok<AutomationRulePatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: AutomationRulePatch = {};
  if (payload.name !== undefined) {
    const check = boundedString(payload.name, "name", 256);
    if (!check.ok) {
      return check;
    }
    value.name = check.value;
  }
  if (payload.triggerType !== undefined) {
    if (typeof payload.triggerType !== "string" || !AUTOMATION_TRIGGER_TYPES.has(payload.triggerType)) {
      return err("Unknown triggerType");
    }
    value.triggerType = payload.triggerType as AutomationRule["triggerType"];
  }
  if (payload.actionType !== undefined) {
    if (typeof payload.actionType !== "string" || !AUTOMATION_ACTION_TYPES.has(payload.actionType)) {
      return err("Unknown actionType");
    }
    value.actionType = payload.actionType as AutomationRule["actionType"];
  }
  if (payload.conditions !== undefined) {
    if (!isPlainObject(payload.conditions)) {
      return err("conditions must be an object");
    }
    value.conditions = payload.conditions as AutomationRule["conditions"];
  }
  if (payload.actionConfig !== undefined) {
    if (!isPlainObject(payload.actionConfig)) {
      return err("actionConfig must be an object");
    }
    value.actionConfig = payload.actionConfig as AutomationRule["actionConfig"];
  }
  if (payload.priority !== undefined) {
    if (typeof payload.priority !== "number" || !Number.isInteger(payload.priority)) {
      return err("priority must be an integer");
    }
    value.priority = Math.min(Math.max(payload.priority, 0), 1000);
  }
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") {
      return err("enabled must be a boolean");
    }
    value.enabled = payload.enabled;
  }
  if (Object.keys(value).length === 0) {
    return err("at least one field is required");
  }
  // assign_agent needs a plausible assignee in the MERGED config; the route
  // still confirms tenant membership against the database.
  const effectiveActionType = value.actionType ?? existing.actionType;
  const effectiveConfig = value.actionConfig ?? existing.actionConfig ?? {};
  if (effectiveActionType === "assign_agent") {
    const assignee = (effectiveConfig as { assigneeUserId?: unknown }).assigneeUserId;
    if (typeof assignee !== "string" || !UUID_RE.test(assignee)) {
      return err("actionConfig.assigneeUserId must be a valid user id for assign_agent");
    }
  }
  return { ok: true, value };
}

// ─── Segments / contacts / channels / users ─────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SegmentPatch {
  name?: string;
  definition?: Record<string, unknown>;
}

export function validateSegmentPatch(payload: unknown): Ok<SegmentPatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: SegmentPatch = {};
  if (payload.name !== undefined) {
    const check = boundedString(payload.name, "name", 200);
    if (!check.ok) {
      return check;
    }
    value.name = check.value;
  }
  if (payload.definition !== undefined) {
    if (!isPlainObject(payload.definition)) {
      return err("definition must be an object");
    }
    value.definition = payload.definition;
  }
  if (Object.keys(value).length === 0) {
    return err("at least one of name or definition is required");
  }
  return { ok: true, value };
}

export interface ContactPatch {
  firstName?: string | null;
  lastName?: string | null;
  timezone?: string | null;
  country?: string;
}

export function validateContactPatch(payload: unknown): Ok<ContactPatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: ContactPatch = {};
  for (const [field, max] of [
    ["firstName", 100],
    ["lastName", 100],
    ["timezone", 64]
  ] as const) {
    const raw = payload[field];
    if (raw === undefined) {
      continue;
    }
    if (raw === null) {
      value[field] = null;
      continue;
    }
    const check = boundedString(raw, field, max);
    if (!check.ok) {
      return check;
    }
    value[field] = check.value;
  }
  if (payload.country !== undefined) {
    const check = boundedString(payload.country, "country", 100);
    if (!check.ok) {
      return check;
    }
    value.country = check.value;
  }
  if (Object.keys(value).length === 0) {
    return err("at least one field is required");
  }
  return { ok: true, value };
}

export interface ChannelPatch {
  displayPhoneNumber?: string;
  isActive?: boolean;
  accessToken?: string | null;
}

export function validateChannelPatch(payload: unknown): Ok<ChannelPatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: ChannelPatch = {};
  if (payload.displayPhoneNumber !== undefined) {
    const check = boundedString(payload.displayPhoneNumber, "displayPhoneNumber", 32);
    if (!check.ok) {
      return check;
    }
    value.displayPhoneNumber = check.value;
  }
  if (payload.isActive !== undefined) {
    if (typeof payload.isActive !== "boolean") {
      return err("isActive must be a boolean");
    }
    value.isActive = payload.isActive;
  }
  if (payload.accessToken !== undefined) {
    if (payload.accessToken === null) {
      value.accessToken = null;
    } else {
      if (typeof payload.accessToken !== "string" || payload.accessToken.length === 0) {
        return err("accessToken must be a non-empty string or null");
      }
      if (payload.accessToken.length > 4096) {
        return err("accessToken must be at most 4096 characters");
      }
      value.accessToken = payload.accessToken;
    }
  }
  if (Object.keys(value).length === 0) {
    return err("at least one field is required");
  }
  return { ok: true, value };
}

const USER_STATUSES = new Set(["active", "invited", "suspended", "disabled"]);

export interface UserPatch {
  status?: string;
  roles?: string[];
  /**
   * Keep the API keys the user created when this patch takes the user out (any status but active); by default they
   * are revoked. Present only when the request sent it.
   */
  keepApiKeys?: boolean;
}

/**
 * Other fields are ignored, as before. keepApiKeys: true is refused (not ignored) with a status of active or no status
 * at all: it would do nothing there, and reactivating a user never restores a key its suspension revoked, so a client
 * that sends it expecting either is told so instead of being answered 200. keepApiKeys: false asks for nothing (it is
 * the default), so there it is accepted as a no-op and left out of the value — a client that always sends the boolean
 * must not get a 400 on a roles edit or a reactivation.
 */
export function validateUserPatch(payload: unknown, validRoles: ReadonlySet<string>): Ok<UserPatch> | Err {
  if (!isPlainObject(payload)) {
    return err("body must be a JSON object");
  }
  const value: UserPatch = {};
  if (payload.status !== undefined) {
    if (typeof payload.status !== "string" || !USER_STATUSES.has(payload.status)) {
      return err(`status must be one of: ${[...USER_STATUSES].join(", ")}`);
    }
    value.status = payload.status;
  }
  if (payload.roles !== undefined) {
    if (!Array.isArray(payload.roles) || payload.roles.length === 0) {
      return err("roles must be a non-empty array");
    }
    const unknown = payload.roles.filter((role) => typeof role !== "string" || !validRoles.has(role));
    if (unknown.length > 0) {
      return err(`Unknown roles: ${unknown.join(", ")}`);
    }
    value.roles = [...new Set(payload.roles as string[])];
  }
  if (payload.keepApiKeys !== undefined && typeof payload.keepApiKeys !== "boolean") {
    return err("keepApiKeys must be a boolean");
  }
  if (Object.keys(value).length === 0) {
    return err("at least one of status or roles is required");
  }
  if (payload.keepApiKeys !== undefined) {
    const takesOut = value.status !== undefined && value.status !== "active";
    if (takesOut) {
      value.keepApiKeys = payload.keepApiKeys;
    } else if (payload.keepApiKeys === true) {
      const takeOut = [...USER_STATUSES].filter((status) => status !== "active");
      return err(
        `keepApiKeys applies only when status is one of: ${takeOut.join(", ")} (reactivating a user does not restore revoked API keys)`
      );
    }
  }
  return { ok: true, value };
}
