// Pure, framework-free UI helpers shared by the portal. Importable in Node for
// unit tests and attached to `window` in the browser for the inline SPA code.

/** HTML-escapes a value for safe interpolation into innerHTML. */
export function esc(value) {
  return value == null
    ? ""
    : String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Formats a timestamp (ISO string or unix seconds/millis) as a short label. */
export function fmtTime(ts) {
  if (!ts) return "";
  let d;
  if (typeof ts === "number" && ts < 2e10) d = new Date(ts * 1000);
  else d = new Date(ts);
  if (isNaN(d)) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Renders Prev/Next pagination controls for an offset-paginated list. */
export function pagerHtml(fn, total, offset, limit, count) {
  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:12px;color:var(--muted)"><span>' +
    (total ? offset + 1 : 0) +
    "–" +
    (offset + count) +
    " of " +
    total +
    '</span><span><button class="btn btn-secondary btn-sm" ' +
    (offset <= 0 ? "disabled" : "") +
    ' onclick="' +
    fn +
    '(-1)">Prev</button> <button class="btn btn-secondary btn-sm" ' +
    (offset + limit >= total ? "disabled" : "") +
    ' onclick="' +
    fn +
    '(1)">Next</button></span></div>'
  );
}

/** Builds a URL query string from an object, skipping empty/undefined values. */
export function buildQuery(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

/**
 * Escapes a value for safe interpolation as a single-quoted JS string literal
 * within a double-quoted HTML onclick attribute.
 * esc() alone is insufficient there because it doesn't escape ' (apostrophe).
 */
export function jsStr(value) {
  return value == null
    ? ""
    : String(value)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/</g, "\\x3C");
}

if (typeof window !== "undefined") {
  Object.assign(window, { esc, fmtTime, pagerHtml, buildQuery, jsStr });
}
