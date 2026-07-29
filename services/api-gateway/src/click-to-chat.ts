/**
 * Click-to-chat tools (roadmap Phase D tail — WATI's free link/QR generator
 * and website widget). Pure link/script builders; the routes in index.ts add
 * auth, channel lookup, and QR rendering.
 */

export type WaLinkResult = { ok: true; value: string } | { ok: false; error: string };

/** wa.me deep link for an E.164 number with an optional prefilled message. */
export function buildWaLink(input: { phone: string; text?: string }): WaLinkResult {
  const cleaned = (input.phone ?? "").replace(/[\s()-]/g, "");
  if (!/^\+?[1-9]\d{7,14}$/.test(cleaned)) {
    return { ok: false, error: "phone must be an E.164 number (e.g. +15551234567)" };
  }
  const url = new URL(`https://wa.me/${cleaned.replace("+", "")}`);
  const text = input.text?.trim();
  if (text) {
    url.searchParams.set("text", text.slice(0, 1024));
  }
  return { ok: true, value: url.toString() };
}

export interface WidgetConfig {
  waLink: string;
  position: "left" | "right";
  label: string;
}

/**
 * Self-contained floating-button script for customer sites. Values are
 * embedded via JSON.stringify so attacker-controlled query params cannot
 * escape into script context; the button is a plain <a> to the wa.me link.
 */
export function renderWidgetScript(config: WidgetConfig): string {
  // JSON.stringify handles quotes/backslashes; the extra "<" escape keeps a
  // literal "</script>" out of the payload even if it is ever inlined.
  const js = (value: string): string => JSON.stringify(value).replace(/</g, "\\u003c");
  const link = js(config.waLink);
  const label = js(config.label.slice(0, 60));
  const side = config.position === "left" ? "left" : "right";
  return `(function () {
  if (document.getElementById("hyfib-wa-widget")) return;
  var a = document.createElement("a");
  a.id = "hyfib-wa-widget";
  a.href = ${link};
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.setAttribute("aria-label", ${label});
  a.style.cssText = "position:fixed;bottom:24px;${side}:24px;z-index:2147483000;display:flex;align-items:center;gap:8px;background:#25D366;color:#fff;font:600 14px/1 system-ui,sans-serif;padding:12px 18px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25);text-decoration:none;";
  a.textContent = ${label};
  var icon = document.createElement("span");
  icon.textContent = "\\uD83D\\uDCAC";
  a.prepend(icon);
  function mount() { document.body.appendChild(a); }
  if (document.body) { mount(); } else { document.addEventListener("DOMContentLoaded", mount); }
})();
`;
}
