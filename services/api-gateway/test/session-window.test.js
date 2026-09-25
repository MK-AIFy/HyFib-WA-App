import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_WINDOW_MS, requiresSessionWindow, evaluateSessionWindow } from "../dist/session-window.js";

/**
 * WhatsApp only accepts free-form messages inside the 24h customer-service window, which each inbound message
 * from the customer reopens. Outside it, only an approved template may be sent.
 *
 * The conversation send route enqueued every kind unconditionally, so an agent typing after the window closed
 * got 202 "message_enqueued" and the send was then rejected at Meta — with nothing in the conversation to show
 * for it. These cases pin the decision the route now makes before enqueuing.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-22T12:00:00.000Z");

/** Every kind the send route accepts; only "template" survives outside the window. */
const FREE_FORM_KINDS = ["text", "media", "interactive", "product", "catalog", "flow", "location", "contacts"];

function at(msAgo) {
  return new Date(NOW - msAgo);
}

test("the window is 24 hours", () => {
  assert.equal(SESSION_WINDOW_MS, 24 * HOUR);
});

test("every free-form kind needs the window; a template does not", () => {
  for (const kind of FREE_FORM_KINDS) {
    assert.equal(requiresSessionWindow(kind), true, `${kind} must require the session window`);
  }
  assert.equal(requiresSessionWindow("template"), false, "a template is how you reach a closed window");
});

test("a free-form message is allowed while the customer's last inbound is recent", () => {
  for (const kind of FREE_FORM_KINDS) {
    const decision = evaluateSessionWindow({ kind, lastInboundAt: at(2 * HOUR), now: NOW });
    assert.equal(decision.allowed, true, `${kind} should be allowed 2h after an inbound`);
    assert.equal(decision.reason, undefined);
  }
});

test("a free-form message is refused once the window has closed", () => {
  for (const kind of FREE_FORM_KINDS) {
    const decision = evaluateSessionWindow({ kind, lastInboundAt: at(25 * HOUR), now: NOW });
    assert.equal(decision.allowed, false, `${kind} should be refused 25h after an inbound`);
    assert.match(decision.reason ?? "", /session window/i, "the reason must say why, for the operator");
  }
});

test("the boundary is exclusive: 24h exactly is closed, a moment under is open", () => {
  // The window is measured from the last inbound, so at exactly 24h it has elapsed. Being strict here is the
  // safe side of the line: Meta rejects the send, and a refusal the agent sees beats a silent failure.
  const closed = evaluateSessionWindow({ kind: "text", lastInboundAt: at(SESSION_WINDOW_MS), now: NOW });
  assert.equal(closed.allowed, false, "exactly 24h after the last inbound the window is closed");

  const open = evaluateSessionWindow({ kind: "text", lastInboundAt: at(SESSION_WINDOW_MS - 1000), now: NOW });
  assert.equal(open.allowed, true, "a second inside the window is still open");
});

test("a template is allowed whatever the window says", () => {
  for (const lastInboundAt of [undefined, at(2 * HOUR), at(25 * HOUR), at(400 * HOUR)]) {
    const decision = evaluateSessionWindow({ kind: "template", lastInboundAt, now: NOW });
    assert.equal(decision.allowed, true, `a template must be sendable (lastInboundAt=${lastInboundAt})`);
  }
});

test("a contact who has never messaged in has no window, so free-form is refused", () => {
  // Business-initiated conversations have to start with a template; there is no window to be inside.
  const decision = evaluateSessionWindow({ kind: "text", lastInboundAt: undefined, now: NOW });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /never/i, "the reason must distinguish this from an expired window");
});

test("the decision reports the last inbound time so the caller can show it", () => {
  const lastInboundAt = at(30 * HOUR);
  const decision = evaluateSessionWindow({ kind: "text", lastInboundAt, now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.lastInboundAt, lastInboundAt.toISOString());

  const never = evaluateSessionWindow({ kind: "text", lastInboundAt: undefined, now: NOW });
  assert.equal(never.lastInboundAt, undefined);
});

test("a last-inbound timestamp in the future is treated as inside the window", () => {
  // Clock skew between the app and the database should not lock an agent out of a live conversation; the
  // failure mode of being lenient here is one rejected send, the failure mode of being strict is a blocked
  // reply to a customer who is actively messaging.
  const decision = evaluateSessionWindow({ kind: "text", lastInboundAt: new Date(NOW + HOUR), now: NOW });
  assert.equal(decision.allowed, true);
});

test("an unparseable last-inbound timestamp is refused, not waved through", () => {
  // The caller passes the conversation's own last_inbound_at, which crosses the repository boundary as an ISO
  // string. A malformed one becomes an Invalid Date, and every comparison against NaN is false — so without
  // this guard a broken timestamp would read as "inside the window" and re-open the silent-failure path.
  const decision = evaluateSessionWindow({ kind: "text", lastInboundAt: new Date("not-a-date"), now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.lastInboundAt, undefined, "an unusable timestamp must not be echoed back as fact");
});

test("an unknown kind is treated as free-form, not waved through", () => {
  // Validation rejects unknown kinds before this point; if a new kind is ever added, it must default to
  // needing the window rather than silently bypassing it.
  assert.equal(requiresSessionWindow("some_future_kind"), true);
  const decision = evaluateSessionWindow({ kind: "some_future_kind", lastInboundAt: at(25 * HOUR), now: NOW });
  assert.equal(decision.allowed, false);
});
