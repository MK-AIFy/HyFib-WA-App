import type { Segment } from "@hyfib/shared-core";

/**
 * Validation for segment definitions arriving over the API (roadmap G6 added
 * the retargeting clause; the create route previously accepted any JSON).
 * Pure module so it is unit-testable without booting the gateway.
 */

const KNOWN_KEYS = new Set(["tags", "country", "hasConsent", "optedInOnly", "campaign"]);
const RECIPIENT_STATUSES = new Set(["pending", "policy_skipped", "sent", "delivered", "read", "failed", "cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SegmentDefinitionResult = { ok: true; value: Segment["definition"] } | { ok: false; error: string };

export function validateSegmentDefinition(value: unknown): SegmentDefinitionResult {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "definition must be an object" };
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, error: `unknown definition key "${key}"` };
    }
  }
  const result: Segment["definition"] = {};
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length > 50 || raw.tags.some((t) => typeof t !== "string" || t.length === 0 || t.length > 100)) {
      return { ok: false, error: "tags must be an array of at most 50 non-empty strings (max 100 chars)" };
    }
    result.tags = raw.tags as string[];
  }
  if (raw.country !== undefined) {
    if (typeof raw.country !== "string" || raw.country.length === 0 || raw.country.length > 100) {
      return { ok: false, error: "country must be a non-empty string of at most 100 characters" };
    }
    result.country = raw.country;
  }
  for (const key of ["hasConsent", "optedInOnly"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") {
        return { ok: false, error: `${key} must be a boolean` };
      }
      result[key] = raw[key];
    }
  }
  if (raw.campaign !== undefined) {
    const campaign = raw.campaign as { id?: unknown; statuses?: unknown; clicked?: unknown };
    if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
      return { ok: false, error: "campaign must be an object" };
    }
    for (const key of Object.keys(campaign)) {
      if (!["id", "statuses", "clicked"].includes(key)) {
        return { ok: false, error: `unknown campaign key "${key}"` };
      }
    }
    if (typeof campaign.id !== "string" || !UUID_RE.test(campaign.id)) {
      return { ok: false, error: "campaign.id must be a campaign UUID" };
    }
    const clause: NonNullable<Segment["definition"]["campaign"]> = { id: campaign.id };
    if (campaign.statuses !== undefined) {
      if (
        !Array.isArray(campaign.statuses) ||
        campaign.statuses.length === 0 ||
        campaign.statuses.some((s) => typeof s !== "string" || !RECIPIENT_STATUSES.has(s))
      ) {
        return {
          ok: false,
          error: `campaign.statuses must be a non-empty array of: ${[...RECIPIENT_STATUSES].join(", ")}`
        };
      }
      clause.statuses = campaign.statuses as string[];
    }
    if (campaign.clicked !== undefined) {
      if (typeof campaign.clicked !== "boolean") {
        return { ok: false, error: "campaign.clicked must be a boolean" };
      }
      clause.clicked = campaign.clicked;
    }
    result.campaign = clause;
  }
  return { ok: true, value: result };
}
