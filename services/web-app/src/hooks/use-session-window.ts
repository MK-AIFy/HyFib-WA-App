import { useEffect, useState } from "react";

/** WhatsApp's customer-service (freeform-message) window: 24h since the last inbound. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the 24h window is open. An absent or unparseable `lastInboundAt`
 * counts as closed — matching the gateway's campaign-policy semantics (no known
 * inbound ⇒ no session).
 */
export function isSessionWindowOpen(lastInboundAt: string | undefined, nowMs: number): boolean {
  if (!lastInboundAt) return false;
  const then = new Date(lastInboundAt).getTime();
  if (Number.isNaN(then)) return false;
  return nowMs - then < SESSION_WINDOW_MS;
}

/**
 * Reactive window state. Derived on every render from `lastInboundAt` (so a live
 * inbound message re-opens it immediately via a new prop) and a `now` clock that
 * ticks each minute so an open window expires while the agent watches the thread.
 */
export function useSessionWindow(lastInboundAt: string | undefined): boolean {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return isSessionWindowOpen(lastInboundAt, nowMs);
}
