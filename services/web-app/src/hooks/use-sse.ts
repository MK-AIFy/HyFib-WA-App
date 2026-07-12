import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type SseStatus = "live" | "offline" | "connecting";

export interface SseEvent {
  topic: string;
  id: string;
  payload: unknown;
}

/**
 * Incrementally parses SSE frames (terminated by a blank line) out of a
 * stream of arbitrarily-chunked text, invoking `onEvent` for each complete
 * frame. State (the in-progress event/data/id fields, and any trailing
 * partial line) is kept across calls to `push`, since a TCP chunk boundary
 * can land in the middle of a single "event: " or "data: " line. Comment
 * lines (heartbeats) start with ":" and are ignored.
 */
export function createSseFrameParser(onEvent: (evt: SseEvent) => void) {
  let buffer = "";
  let eventName: string | null = null;
  let dataLine: string | null = null;
  let id: string | null = null;

  function push(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event: ")) {
        eventName = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      } else if (line.startsWith("id: ")) {
        id = line.slice(4);
      } else if (line === "") {
        if (eventName && dataLine) {
          try {
            onEvent({ topic: eventName, id: id ?? "", payload: JSON.parse(dataLine) as unknown });
          } catch {
            // Malformed frame — drop it rather than crashing the stream.
          }
        }
        eventName = null;
        dataLine = null;
        id = null;
      }
    }
  }

  return { push };
}

function handleEvent(evt: SseEvent, queryClient: QueryClient): void {
  switch (evt.topic) {
    case "task.reminder": {
      const data = evt.payload as { title?: string };
      toast(`Reminder: ${data.title ?? "Task due"}`);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      return;
    }
    case "conversation.assigned":
    case "conversation.team_assigned": {
      toast("A conversation was assigned to you");
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      return;
    }
    case "conversation.state_changed": {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      return;
    }
    case "conversation.read": {
      // Broadcast directly via sseHub.broadcast(tenantId, "conversation.read", id,
      // { conversationId }) in api-gateway/src/index.ts — a flat payload, same as
      // conversation.assigned/team_assigned/state_changed above, NOT the nested
      // { occurredAt, payload } shape forwardEventToSse wraps bus-forwarded topics
      // (whatsapp.inbound.received, media.stored) in below. No per-id targeting is
      // needed here since a full ["conversations"] invalidation already covers the
      // multi-tab/agent sync this event exists for.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      return;
    }
    case "whatsapp.inbound.received":
    case "whatsapp.status.updated": {
      const data = evt.payload as { payload?: { conversationId?: string } };
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      const conversationId = data.payload?.conversationId;
      if (conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
      return;
    }
    case "media.stored": {
      // The blob query for this asset only mounts once payload.mediaAsset
      // lands on the message, which this refetch brings — no separate
      // ["media-blob", assetId] invalidation needed since it doesn't exist yet.
      const data = evt.payload as { payload?: { conversationId?: string } };
      const conversationId = data.payload?.conversationId;
      if (conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
      return;
    }
    default:
      return;
  }
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function useSse(enabled: boolean): SseStatus {
  const [status, setStatus] = useState<SseStatus>("offline");
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let attempt = 0;

    async function connect() {
      setStatus("connecting");
      try {
        // Cookie auth: the browser attaches hf_session automatically
        // (same-origin default) — the connect guard above (`enabled`) is
        // what tracks whether there's an authenticated user to stream for.
        const res = await fetch("/api/v1/events/stream", {
          signal: controller.signal
        });
        if (!res.body) {
          throw new Error("SSE stream has no body");
        }
        setStatus("live");
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseFrameParser((evt) => handleEvent(evt, queryClient));
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          parser.push(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
      }
      if (cancelled) {
        return;
      }
      setStatus("offline");
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      attempt += 1;
      setTimeout(() => {
        if (!cancelled) {
          void connect();
        }
      }, delay);
    }

    void connect();
    return () => {
      cancelled = true;
      controller.abort();
      setStatus("offline");
    };
  }, [enabled, queryClient]);

  return status;
}
