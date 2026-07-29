/**
 * Pure pieces of the template-lifecycle admin flow (roadmap A3): the proxy op
 * union shared by the HTTP default and the in-process app-server wiring, the
 * proxy-result mapping, and the PATCH body validation. Kept separate from
 * index.ts so they are unit-testable without booting the gateway (same
 * pattern as media-upload.ts).
 */

export const TEMPLATE_CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;

/** Meta only reviews these template categories; "service" is local-only. */
export const META_SUBMITTABLE_CATEGORIES: ReadonlySet<string> = new Set(["marketing", "utility", "authentication"]);

export type TemplateAdminOp =
  | {
      kind: "submit";
      wabaId: string;
      accessToken?: string;
      name: string;
      language: string;
      category: string;
      bodyText: string;
    }
  | {
      kind: "edit";
      metaTemplateId: string;
      accessToken?: string;
      category?: string;
      bodyText?: string;
    }
  | {
      kind: "delete";
      wabaId: string;
      accessToken?: string;
      name: string;
      metaTemplateId?: string;
    };

export type TemplateAdminProxy = (
  op: TemplateAdminOp,
  ctx: { tenantId: string; requestId: string }
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type TemplateAdminOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "error"; status: number; body: Record<string, unknown> };

/**
 * Contract (mirrors mapMediaUploadProxyResult):
 * - 2xx                -> ok
 * - 4xx except 401/403 -> passed through verbatim (adapter-side validation)
 * - 401/403            -> 502 — a Meta/adapter auth failure must never
 *                         masquerade as a gateway auth response
 * - 503                -> 503 meta_adapter_unavailable
 * - anything else      -> 502 with the caller's fallback error name; prefers
 *                         the Graph error message as detail when present
 */
export function mapTemplateAdminProxyResult(
  status: number,
  body: Record<string, unknown>,
  fallbackError: string
): TemplateAdminOutcome {
  if (status >= 200 && status < 300) {
    return { kind: "ok", body };
  }
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    return { kind: "error", status, body };
  }
  const errorName = typeof body.error === "string" ? body.error : "meta error";
  if (status === 503) {
    const details = typeof body.details === "string" ? body.details : undefined;
    return { kind: "error", status: 503, body: { error: "meta_adapter_unavailable", detail: details ?? errorName } };
  }
  const graphMessage =
    body.details &&
    typeof body.details === "object" &&
    typeof (body.details as { message?: unknown }).message === "string"
      ? (body.details as { message: string }).message
      : undefined;
  return { kind: "error", status: 502, body: { error: fallbackError, detail: graphMessage ?? errorName } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TemplatePatchValue {
  category?: (typeof TEMPLATE_CATEGORIES)[number];
  body?: string;
  channelId?: string;
}

export type TemplatePatchResult = { ok: true; value: TemplatePatchValue } | { ok: false; error: string };

/**
 * Validates a PATCH /api/v1/templates/:id body. Bounds mirror the create
 * route exactly (category enum, body <= 1024). channelId is only *required*
 * for templates already submitted to Meta — that rule needs the template row,
 * so it lives in the route; here it is merely shape-checked when present.
 */
export function validateTemplatePatch(payload: unknown): TemplatePatchResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = payload as { category?: unknown; body?: unknown; channelId?: unknown };
  const value: TemplatePatchValue = {};
  if (raw.category !== undefined) {
    if (
      typeof raw.category !== "string" ||
      !TEMPLATE_CATEGORIES.includes(raw.category as (typeof TEMPLATE_CATEGORIES)[number])
    ) {
      return { ok: false, error: `category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}` };
    }
    value.category = raw.category as (typeof TEMPLATE_CATEGORIES)[number];
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
      return { ok: false, error: "body must be a non-empty string" };
    }
    if (raw.body.length > 1024) {
      return { ok: false, error: "body must be at most 1024 characters" };
    }
    value.body = raw.body.trim();
  }
  if (raw.channelId !== undefined) {
    if (typeof raw.channelId !== "string" || !UUID_RE.test(raw.channelId)) {
      return { ok: false, error: "channelId must be a UUID" };
    }
    value.channelId = raw.channelId;
  }
  if (value.category === undefined && value.body === undefined) {
    return { ok: false, error: "at least one of category or body is required" };
  }
  return { ok: true, value };
}
