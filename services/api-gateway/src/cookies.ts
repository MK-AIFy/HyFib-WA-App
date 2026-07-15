import type { IncomingHttpHeaders } from "node:http";

/**
 * HttpOnly cookie session support for the api-gateway. Pure functions only —
 * no I/O, no Node http.ServerResponse coupling — so they can be unit tested
 * directly and reused by index.ts's request handler.
 *
 * CSRF model: same-origin deployment (nginx in prod, Vite proxy in dev), the
 * gateway emits no CORS headers, and SameSite=Strict already blocks the
 * cookie being sent on cross-site navigations/requests. `csrfViolation` adds
 * a belt-and-braces custom-header check (x-requested-with) for the narrow
 * case of cookie-only, same-site mutating requests (e.g. a same-site form
 * post or a compromised same-site subdomain), matching the classic
 * double-submit / custom-header CSRF defense pattern.
 */

export const SESSION_COOKIE = "hf_session";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exact-match exempt paths: anonymous auth entrypoints. */
const CSRF_EXEMPT_EXACT_PATHS = new Set<string>(["/auth/login", "/auth/register"]);

/**
 * Prefix-match exempt paths:
 *  - Meta webhook ingestion — HMAC-signature authenticated, cookie-irrelevant.
 *  - /r/ link-click redirects — public, cookie-irrelevant (covered even if a
 *    mutating method is ever added here).
 */
const CSRF_EXEMPT_PATH_PREFIXES: readonly string[] = ["/api/v1/webhooks/", "/r/"];

function isCsrfExemptPath(path: string): boolean {
  if (CSRF_EXEMPT_EXACT_PATHS.has(path)) return true;
  return CSRF_EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Tolerant Cookie header parser. Never throws: malformed pairs are skipped
 * and per-value URI-decoding failures fall back to the raw value.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const rawPair of header.split(";")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) continue; // no '=' (-1) or empty name (0): malformed, skip
    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1); // preserves any further '=' inside the value
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Builds the Set-Cookie value for issuing/refreshing the session cookie. */
export function serializeSessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  const base = `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${opts.maxAgeSeconds}; HttpOnly; SameSite=Strict`;
  return opts.secure ? `${base}; Secure` : base;
}

/** Builds the Set-Cookie value that clears the session cookie (logout). */
export function clearSessionCookieValue(secure: boolean): string {
  const base = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
  return secure ? `${base}; Secure` : base;
}

function headerPresent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.length > 0;
}

/**
 * TRUE only when a mutating, cookie-authenticated request has no other proof
 * it was issued deliberately by our own frontend script (a Bearer header, or
 * the x-requested-with marker), and the path isn't an explicitly exempt,
 * cookie-irrelevant/anonymous route. A request with no session cookie at all
 * has nothing CSRF-relevant to protect, so it is never a violation here.
 */
export function csrfViolation(method: string, path: string, headers: IncomingHttpHeaders): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (headerPresent(headers.authorization)) return false;
  const cookies = parseCookies(headers.cookie);
  if (!(SESSION_COOKIE in cookies)) return false;
  if (headerPresent(headers["x-requested-with"])) return false;
  if (isCsrfExemptPath(path)) return false;
  return true;
}
