import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";

/** Meta shows the typing indicator for ~25s; refresh a little before it expires. */
const TYPING_THROTTLE_MS = 20_000;

/**
 * Returns a fire-and-forget callback that sends a typing indicator to the
 * customer, throttled to once per ~20s (leading edge, so it appears on the first
 * keystroke). Every error is swallowed by design: 409 `no_recent_inbound_message`,
 * 422 `contact_opted_out`, and 502 upstream failures are all normal and must
 * never surface to the agent. The throttle resets when the conversation changes.
 */
export function useTypingIndicator(conversationId: string) {
  const lastSentRef = useRef(0);

  useEffect(() => {
    lastSentRef.current = 0;
  }, [conversationId]);

  return useCallback(() => {
    const now = Date.now();
    if (now - lastSentRef.current < TYPING_THROTTLE_MS) return;
    lastSentRef.current = now; // set before the request so a keystroke burst can't double-fire
    void api.post(`/api/v1/conversations/${conversationId}/typing`).catch(() => {
      // Best-effort, ephemeral — see the doc comment.
    });
  }, [conversationId]);
}
