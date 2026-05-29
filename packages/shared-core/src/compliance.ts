// WhatsApp marketing compliance: detect opt-out / opt-in intents from inbound
// free-text so the platform can honour STOP requests automatically.

const OPT_OUT_KEYWORDS = new Set(["stop", "unsubscribe", "cancel", "end", "quit", "stopall", "optout", "opt-out"]);
const OPT_IN_KEYWORDS = new Set(["start", "unstop", "subscribe", "yes", "optin", "opt-in"]);

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z\- ]/g, "");
}

/** True if the inbound text is an opt-out command (e.g. "STOP", "unsubscribe"). */
export function isOptOutKeyword(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalize(text);
  return OPT_OUT_KEYWORDS.has(normalized) || normalized.split(" ").some((word) => OPT_OUT_KEYWORDS.has(word));
}

/** True if the inbound text is an opt-in command (e.g. "START", "subscribe"). */
export function isOptInKeyword(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalize(text);
  return OPT_IN_KEYWORDS.has(normalized) || normalized.split(" ").some((word) => OPT_IN_KEYWORDS.has(word));
}
