import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

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

/**
 * Every React Query key family an SSE event keeps fresh. handleEvent builds
 * each invalidation from these (`messages` is extended with a
 * conversationId), and a reconnect refetches every family as a whole — the
 * gateway has no replay (no Last-Event-ID), so an event broadcast while no
 * stream was open is only recoverable by refetching. A new family belongs
 * here, never as a literal key in handleEvent, so the two cannot drift.
 */
const SSE_QUERY_KEYS = {
  conversations: ["conversations"],
  messages: ["messages"],
  tasks: ["tasks"]
} as const satisfies Record<string, QueryKey>;

/** Invalidated (as prefixes) each time a stream is re-established. */
export const SSE_RESYNC_QUERY_KEYS: readonly QueryKey[] = Object.values(SSE_QUERY_KEYS);

function resyncAfterReconnect(queryClient: QueryClient): void {
  for (const queryKey of SSE_RESYNC_QUERY_KEYS) {
    // cancelRefetch: false — a refetch already in flight is left to finish
    // instead of being restarted, so back-to-back reconnects cannot keep
    // cancelling each other's refetch and stop the data ever loading.
    void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  }
}

function handleEvent(evt: SseEvent, queryClient: QueryClient): void {
  switch (evt.topic) {
    case "task.reminder": {
      const data = evt.payload as { title?: string };
      toast(`Reminder: ${data.title ?? "Task due"}`);
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.tasks });
      return;
    }
    case "conversation.assigned":
    case "conversation.team_assigned": {
      toast("A conversation was assigned to you");
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.conversations });
      return;
    }
    case "conversation.state_changed": {
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.conversations });
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
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.conversations });
      return;
    }
    case "conversation.archived":
    case "conversation.pinned": {
      // Broadcast via sseHub.broadcast(tenantId, "conversation.archived"/"conversation.pinned",
      // id, { conversationId, archived/pinned }) in api-gateway/src/index.ts — flat payloads,
      // same shape as conversation.read above. A full ["conversations"] invalidation covers
      // both the archived-folder membership change and pinned-first reordering.
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.conversations });
      return;
    }
    case "whatsapp.inbound.received":
    case "whatsapp.status.updated": {
      const data = evt.payload as { payload?: { conversationId?: string } };
      void queryClient.invalidateQueries({ queryKey: SSE_QUERY_KEYS.conversations });
      const conversationId = data.payload?.conversationId;
      if (conversationId) {
        void queryClient.invalidateQueries({ queryKey: [...SSE_QUERY_KEYS.messages, conversationId] });
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
        void queryClient.invalidateQueries({ queryKey: [...SSE_QUERY_KEYS.messages, conversationId] });
      }
      return;
    }
    default:
      return;
  }
}

const STREAM_PATH = "/api/v1/events/stream";
/** The session endpoint AuthProvider's boot effect also asks. */
const SESSION_PROBE_PATH = "/auth/me";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** No jittered retry is sooner than this, so a failing gateway is never hit back-to-back. */
const MIN_BACKOFF_MS = 250;
/** A stable stream that ends cleanly reconnects at a random point in this window. */
const CLEAN_END_JITTER_MS = 5_000;
/**
 * How long a stream must stay live before the backoff resets. Resetting on
 * any 2xx let a stream that opens and closes at once reconnect every second.
 */
const STABLE_STREAM_MS = 30_000;
/** Reconnect resyncs run at most once per this interval (see requestResync). */
const RESYNC_MIN_INTERVAL_MS = 30_000;
/** Retries are logged at debug until this many failures in a row, then at warn. */
const WARN_AFTER_RETRIES = 5;

/**
 * Backoff delay before retry `attempt` (0-based), with full jitter: a random
 * point between a small floor and the doubling cap. Without jitter, every
 * client the gateway drops in the same sweep retries at the same instant,
 * and the cohort stays in step on every later cycle.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(MIN_BACKOFF_MS + random() * (cap - MIN_BACKOFF_MS));
}

/**
 * Delay before replacing a stable stream that ended cleanly (the gateway's
 * lifetime cap): a random 0–5s, so streams capped in the same sweep do not
 * all reconnect, and refetch, together.
 */
export function cleanEndDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * CLEAN_END_JITTER_MS);
}

type SessionProbe = "gone" | "valid" | "unconfirmed";

/**
 * The gateway answers 401 for ANY failure while resolving auth on the stream
 * route — a database error or pool timeout included, not only a dead
 * session — so a stream 401 alone is not proof the user is signed out. Ask
 * the session endpoint through the shared client instead. A 401 there went
 * through request(), which has already run the app's one sign-out path
 * (clear stored session, notify AuthProvider), so the caller must not sign
 * out again. Any other failure (5xx, network, other 4xx) leaves the session
 * unconfirmed either way.
 */
async function probeSession(): Promise<SessionProbe> {
  try {
    await api.get<unknown>(SESSION_PROBE_PATH);
    return "valid";
  } catch (error) {
    return error instanceof ApiError && error.status === 401 ? "gone" : "unconfirmed";
  }
}

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
    // Every connect() after this effect's first one is a reconnect: the
    // stream before it ended, or earlier attempts failed, and either way
    // events broadcast in that gap were never delivered. The first connect
    // skips the resync — the page's queries are loading fresh anyway.
    let connectCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    let lastResyncAt = Number.NEGATIVE_INFINITY;

    function runResync(): void {
      lastResyncAt = Date.now();
      resyncAfterReconnect(queryClient);
    }

    // At most one resync per RESYNC_MIN_INTERVAL_MS: a flapping stream would
    // otherwise refetch every key family on every reconnect. A resync asked
    // for inside the window is deferred to the window's end, never dropped —
    // the reconnect that asked still has a gap only a refetch can close, and
    // one deferred resync covers every gap before it runs.
    function requestResync(): void {
      if (resyncTimer !== undefined) {
        return;
      }
      const waitMs = lastResyncAt + RESYNC_MIN_INTERVAL_MS - Date.now();
      if (waitMs <= 0) {
        runResync();
        return;
      }
      resyncTimer = setTimeout(() => {
        resyncTimer = undefined;
        if (!cancelled) {
          runResync();
        }
      }, waitMs);
    }

    function scheduleReconnect(delay: number): void {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!cancelled) {
          void connect();
        }
      }, delay);
    }

    async function connect() {
      const isReconnect = connectCount > 0;
      connectCount += 1;
      setStatus("connecting");
      // Set once the stream is live; undefined means this attempt never got there.
      let liveAt: number | undefined;
      // Why this attempt ended, when it was not a clean end of a live stream.
      let failure: string | undefined;
      try {
        // Cookie auth: the browser attaches hf_session automatically
        // (same-origin default) — the connect guard above (`enabled`) is
        // what tracks whether there's an authenticated user to stream for.
        const res = await fetch(STREAM_PATH, {
          signal: controller.signal
        });
        if (cancelled) {
          return;
        }
        if (!res.ok) {
          // An error body is JSON, not SSE frames — never read it as a stream.
          void res.body?.cancel().catch(() => undefined);
          if (res.status === 403) {
            // This principal may not stream at all (e.g. no roles); retrying cannot fix that.
            console.warn("[sse] event stream refused with HTTP 403; not reconnecting");
            setStatus("offline");
            return;
          }
          if (res.status === 401) {
            setStatus("offline");
            const session = await probeSession();
            if (cancelled) {
              return;
            }
            if (session === "gone") {
              // probeSession's 401 already signed out through request();
              // AuthProvider drops the user, which disables this hook.
              console.warn("[sse] event stream refused with HTTP 401 and the session is gone; not reconnecting");
              return;
            }
            const detail = session === "valid" ? "the session is still valid" : "the session could not be confirmed";
            console.warn(`[sse] event stream refused with HTTP 401 but ${detail}; treating it as transient`);
            throw new Error(`HTTP 401 (${detail})`);
          }
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error("response has no body");
        }
        setStatus("live");
        liveAt = Date.now();
        if (isReconnect) {
          // The gateway flushes the response headers BEFORE it registers this
          // client (res.flushHeaders(), then sseHub.addClient()), not after.
          // There is no gap between the two only because they run in the
          // same synchronous tick, so no broadcast can run in between: once
          // the headers reach us the client is registered and every later
          // event arrives on this stream. Refetching from here therefore
          // closes the gap without opening a new one. If the gateway ever
          // awaits between flushing and registering, this stops holding.
          requestResync();
        }
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
        const reason = error instanceof Error ? error.message : String(error);
        failure = liveAt === undefined ? `connect failed: ${reason}` : `stream failed after going live: ${reason}`;
      }
      if (cancelled) {
        return;
      }

      const liveForMs = liveAt === undefined ? undefined : Date.now() - liveAt;
      const endedCleanly = liveForMs !== undefined && failure === undefined;
      if (liveForMs !== undefined && liveForMs >= STABLE_STREAM_MS) {
        attempt = 0;
        if (endedCleanly) {
          const jitterMs = cleanEndDelayMs();
          console.debug(
            `[sse] stream ended after ${Math.round(liveForMs / 1000)}s live; reconnecting in ${jitterMs}ms`
          );
          setStatus("connecting");
          scheduleReconnect(jitterMs);
          return;
        }
      }
      // A clean end means the gateway closed a healthy stream (e.g. its
      // lifetime cap): show "connecting", not a red "offline" that the
      // Topbar's role="status" region would announce. Failed attempts, and
      // streams that errored, are offline.
      setStatus(endedCleanly ? "connecting" : "offline");
      const delay = retryDelayMs(attempt);
      attempt += 1;
      const message = `[sse] ${failure ?? `stream ended after ${liveForMs ?? 0}ms live`}; retry ${attempt} in ${delay}ms`;
      if (attempt >= WARN_AFTER_RETRIES) {
        console.warn(message);
      } else {
        console.debug(message);
      }
      scheduleReconnect(delay);
    }

    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearTimeout(resyncTimer);
      controller.abort();
      setStatus("offline");
    };
  }, [enabled, queryClient]);

  return status;
}
