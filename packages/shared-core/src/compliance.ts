// WhatsApp marketing compliance: detect opt-out / opt-in intents from inbound
// free-text so the platform can honour STOP requests automatically.
//
// An opt-out blocks every later outbound message to the contact, so a false positive silently cuts a customer
// off ("can you cancel my order?") while a false negative leaves a STOP unhonoured. Words are therefore trusted
// only as far as they are unambiguous: "unsubscribe" counts anywhere, "cancel"/"end"/"quit" only as the whole
// message, and "stop" only as a whole request ("please stop", "stop sending me messages"). Opt-in re-grants
// consent, the worse error to get wrong, so it only ever matches the whole message.

const OPT_OUT_ANYWHERE = new Set(["unsubscribe", "optout", "stopall"]);
const OPT_OUT_WHOLE_MESSAGE = new Set(["cancel", "end", "quit"]);
// Deliberately not "yes": it answers any question, so it would silently re-subscribe an opted-out customer.
const OPT_IN_WHOLE_MESSAGE = new Set(["start", "unstop", "subscribe", "optin"]);

// Words that pad or soften a stop request without changing what it asks ("can you please stop messaging me").
const STOP_FILLER = new Set([
  ...["i", "id", "u", "you", "me", "us", "my", "it", "this"],
  ...["can", "could", "would", "like", "want", "wanna", "need", "to", "said", "told"],
  ...["please", "pls", "plz", "kindly", "thanks", "thank", "thx", "just", "now", "all"],
  ...["again", "already", "anymore", "the", "these", "those", "any", "more"],
  ...["hi", "hello", "hey", "sir", "madam", "mam", "ok", "okay"]
]);

// Words that say what to stop ("stop sending me whatsapp messages"). Any other word after "stop" is a qualifier
// or a different verb ("stop by", "stop all deliveries until Monday"), which is not a request to stop messaging.
const STOP_OBJECT = new Set([
  ...["sending", "messaging", "texting", "contacting", "receiving", "spamming"],
  ...["messages", "message", "msgs", "msg", "texts", "text", "sms", "whatsapp", "number"],
  ...["updates", "notifications", "offers", "promotions", "promotional", "marketing", "spam"]
]);

/**
 * Lower-cased words of an inbound message. Punctuation, emoji and underscores separate words (so a button payload
 * such as "STOP_PROMOTIONS" reads like "stop promotions"), apostrophes vanish ("don't" becomes "dont"), digits stay
 * part of the message ("cancel 12345" is not the bare word), and "opt out" / "opt-out" / "opt in" become one word.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\bopt[\s-]*(out|in)\b/g, "opt$1")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** "stop" (repeated or softened), optionally followed by what to stop; any other word makes it another request. */
function isStopRequest(words: string[]): boolean {
  const core = words.filter((word) => !STOP_FILLER.has(word));
  let stops = 0;
  while (core[stops] === "stop") {
    stops += 1;
  }
  return stops > 0 && core.slice(stops).every((word) => STOP_OBJECT.has(word));
}

/** True if the inbound text is an opt-out command (e.g. "STOP", "please unsubscribe me", "Stop promotions"). */
export function isOptOutKeyword(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const words = tokenize(text);
  return (
    words.some((word) => OPT_OUT_ANYWHERE.has(word)) ||
    OPT_OUT_WHOLE_MESSAGE.has(words.join(" ")) ||
    isStopRequest(words)
  );
}

/** True if the inbound text is exactly an opt-in command (e.g. "START", "subscribe"). */
export function isOptInKeyword(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return OPT_IN_WHOLE_MESSAGE.has(tokenize(text).join(" "));
}
