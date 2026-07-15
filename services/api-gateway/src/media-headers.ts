/**
 * Pure header-building helpers for the authenticated media serving route
 * (`GET /api/v1/media/:assetId`). Kept separate from index.ts so the
 * filename-sanitization logic — the part with header-injection risk — has a
 * narrow, directly testable surface (see the gateway's validation.ts / csv.ts
 * convention).
 */

export interface MediaHeadersInput {
  mimeType?: string;
  filename?: string;
  byteLength: number;
}

const MAX_FILENAME_LENGTH = 150;

/**
 * Reduces a stored filename to a value safe to embed inside a quoted
 * Content-Disposition filename parameter.
 *
 * Design choice (brief 15.B): rather than emit RFC 5987 `filename*=UTF-8''...`
 * for non-ASCII names, we fall back to a conservative printable-ASCII
 * allowlist. Media filenames here are informational only — the `Content-Type`
 * header (from the stored mime type) governs how a client handles the bytes —
 * so losing exotic characters from the display name isn't worth a second
 * encoding path and its own injection surface.
 *
 * Strips: CR/LF and other control characters (header-injection vector),
 * `"` and `\` (would escape out of the quoted-string), and anything outside
 * printable ASCII (0x20-0x7E). Result is trimmed and capped at
 * MAX_FILENAME_LENGTH.
 */
function sanitizeFilename(filename: string): string {
  let safe = "";
  for (const ch of filename) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control chars, incl. CR/LF/tab
    if (code > 0x7e) continue; // non-ASCII — see doc comment above
    if (ch === '"' || ch === "\\") continue; // would break the quoted-string
    safe += ch;
  }
  return safe.trim().slice(0, MAX_FILENAME_LENGTH);
}

/** Builds the Content-Disposition value, omitting the filename param entirely when none survives sanitization. */
function buildContentDisposition(filename?: string): string {
  if (!filename) return "inline";
  const safe = sanitizeFilename(filename);
  return safe ? `inline; filename="${safe}"` : "inline";
}

/**
 * Builds the response headers for a stored media asset. `byteLength` must be
 * the length of the actual buffer being sent (never a stored/derived value
 * that could drift from it).
 */
export function buildMediaHeaders(input: MediaHeadersInput): Record<string, string> {
  return {
    "Content-Type": input.mimeType?.trim() || "application/octet-stream",
    "Content-Length": String(input.byteLength),
    "Content-Disposition": buildContentDisposition(input.filename),
    "Cache-Control": "private, max-age=86400"
  };
}
