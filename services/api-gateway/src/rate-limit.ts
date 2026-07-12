/**
 * Route classification for the general API rate limiter. Pure, no I/O — the
 * request handler (index.ts) owns the actual Redis check via
 * @hyfib/ratelimit's checkRateLimit; this module only decides which bucket
 * (and therefore which per-minute limit) a given method+path falls into.
 *
 * Login/register keep their own dedicated 5/min limiter (isAuthRateLimited in
 * index.ts) and are exempt here to avoid double-throttling.
 */

export type RouteClass = "read" | "write" | "expensive" | "exempt";

/** Per-subject, per-minute limits. Exempt routes have no limit at all. */
export const API_RATE_LIMITS: Record<Exclude<RouteClass, "exempt">, number> = {
  read: 600,
  write: 120,
  expensive: 10
};

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exact-path exemptions: long-lived SSE, ops endpoints, and the two
 * already-throttled anonymous auth entrypoints. */
const EXEMPT_EXACT_PATHS = new Set<string>([
  "/api/v1/events/stream", // long-lived SSE — must never be throttled/disconnected
  "/health",
  "/metrics",
  "/auth/login", // own 5/min limiter (isAuthRateLimited)
  "/auth/register" // own 5/min limiter (isAuthRateLimited); also 410 (self-reg disabled)
]);

/** Prefix exemptions: HMAC-authenticated webhooks (nginx webhook_limit covers
 * abuse) and public link-click redirects. */
const EXEMPT_PATH_PREFIXES: readonly string[] = ["/api/v1/webhooks/", "/r/"];

const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CAMPAIGN_RUN_PATTERN = new RegExp(`^/api/v1/campaigns/${UUID_SEGMENT}/run$`, "i");
const MEDIA_UPLOAD_PATTERN = new RegExp(`^/api/v1/channels/whatsapp/${UUID_SEGMENT}/media$`, "i");

/** Exact-match expensive routes (fixed path, no variable segment). */
const EXPENSIVE_EXACT: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/v1/contacts/import" },
  { method: "GET", path: "/api/v1/contacts/export" },
  // Route ships in a later task; classified now so it's throttled the day it
  // lands rather than defaulting to the much looser "read" bucket.
  { method: "GET", path: "/api/v1/messages/search" }
];

/**
 * Classifies a request into a rate-limit bucket. Order matters:
 *  1. EXEMPT — explicit exact/prefix list above, checked first because it
 *     includes the SSE stream (must never be throttled) and paths with their
 *     own limiter (login/register) or perimeter defense (webhooks).
 *  2. EXPENSIVE — small fixed set of known-costly endpoints (bulk CSV I/O,
 *     campaign fan-out, media upload, full-text search).
 *  3. WRITE — any other mutating method under /api/, plus /auth/logout (the
 *     only mutating /auth/* route without its own limiter).
 *  4. READ — any other GET/HEAD under /api/.
 *  5. Fallback EXEMPT — anything else, including /auth/me and any unmatched
 *     path. Unmatched paths under neither /api/ nor /auth/ 404 before ever
 *     reaching the gate, so throttling them is moot. /auth/me and any other
 *     unlisted /auth/* path are handled in index.ts's auth-routes section,
 *     which returns *before* resolveAuth() runs — the general rate-limit
 *     gate (placed after auth resolves) never sees them regardless of what
 *     they classify as here, so "exempt" is just the accurate label for a
 *     route this gate structurally cannot reach. See the comment at the
 *     gate's call site in index.ts for the full rationale (Task 19 Part 2).
 */
export function classifyRoute(method: string, path: string): RouteClass {
  const m = method.toUpperCase();

  if (EXEMPT_EXACT_PATHS.has(path)) return "exempt";
  if (EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return "exempt";

  if (path.startsWith("/api/")) {
    if (EXPENSIVE_EXACT.some((r) => r.method === m && r.path === path)) return "expensive";
    if (m === "POST" && CAMPAIGN_RUN_PATTERN.test(path)) return "expensive";
    if (m === "POST" && MEDIA_UPLOAD_PATTERN.test(path)) return "expensive";
    if (MUTATING_METHODS.has(m)) return "write";
    if (m === "GET" || m === "HEAD") return "read";
    return "exempt"; // unrecognized method under /api/ — handler 405s, nothing to throttle
  }

  if (path.startsWith("/auth/")) {
    if (m === "POST" && path === "/auth/logout") return "write";
    return "exempt"; // /auth/me and any other unlisted /auth/* path — see rule 5 above
  }

  return "exempt"; // not under /api/ or /auth/ — unknown paths 404 anyway
}
