/**
 * The WhatsApp 24h customer-service window. Pure, no I/O — the request handler (index.ts) reads the last
 * inbound timestamp and owns the response; this module only decides whether a given message kind may be sent.
 *
 * Meta accepts free-form messages (text, media, interactive, …) only while the window is open, and each
 * inbound message from the customer reopens it for another 24 hours. Outside the window the only thing that
 * gets through is an approved template — that is what templates are for.
 *
 * Deciding this before enqueuing matters because the send is asynchronous: the route answers 202 and the
 * outbox dispatches later, so a message Meta was always going to reject came back to the agent as success and
 * then failed out of sight.
 */

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this kind needs an open window. Only "template" does not; everything else — including any kind added
 * later — is treated as free-form, so a new kind cannot bypass the check by being unknown here.
 */
export function requiresSessionWindow(kind: string): boolean {
  return kind !== "template";
}

export interface SessionWindowDecision {
  allowed: boolean;
  /** Operator-facing explanation, present only when the send is refused. */
  reason?: string;
  /** The last inbound time the decision was made against, so the caller can surface it. */
  lastInboundAt?: string;
}

/**
 * Decides whether `kind` may be sent, given when the customer last messaged in.
 *
 * A timestamp in the future counts as inside the window: that means clock skew between the app and the
 * database, and locking an agent out of a conversation the customer is actively using is the worse error.
 */
export function evaluateSessionWindow(params: {
  kind: string;
  lastInboundAt?: Date;
  now?: number;
}): SessionWindowDecision {
  const { kind } = params;
  const now = params.now ?? Date.now();
  // The caller reads this off a conversation row, where it crosses the repository boundary as an ISO string.
  // An unparseable one yields an Invalid Date, and every comparison against NaN is false — so it has to be
  // rejected here rather than falling through as "not expired", which is how it would otherwise read.
  const lastInboundAt =
    params.lastInboundAt && !Number.isNaN(params.lastInboundAt.getTime()) ? params.lastInboundAt : undefined;
  const lastInboundIso = lastInboundAt ? lastInboundAt.toISOString() : undefined;

  if (!requiresSessionWindow(kind)) {
    return { allowed: true, lastInboundAt: lastInboundIso };
  }

  if (!lastInboundAt) {
    return {
      allowed: false,
      reason: "This contact has never messaged in, so there is no 24h session window open. Send a template instead."
    };
  }

  if (now - lastInboundAt.getTime() >= SESSION_WINDOW_MS) {
    return {
      allowed: false,
      reason: `The 24h session window closed (the contact last messaged at ${lastInboundIso}). Send a template instead.`,
      lastInboundAt: lastInboundIso
    };
  }

  return { allowed: true, lastInboundAt: lastInboundIso };
}
