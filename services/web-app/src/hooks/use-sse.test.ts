import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { setUnauthorizedHandler } from "../lib/api";
import { writeSession } from "../lib/auth-storage";
import {
  cleanEndDelayMs,
  createSseFrameParser,
  retryDelayMs,
  SSE_RESYNC_QUERY_KEYS,
  useSse,
  type SseEvent,
  type SseStatus
} from "./use-sse";

describe("createSseFrameParser", () => {
  it("parses a complete frame delivered in one push", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    parser.push('id: 1\nevent: task.reminder\ndata: {"taskId":"t1","title":"Call back"}\n\n');

    expect(events).toEqual([{ topic: "task.reminder", id: "1", payload: { taskId: "t1", title: "Call back" } }]);
  });

  it("reassembles a frame whose data line is split across chunks", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    parser.push('event: task.reminder\ndata: {"tas');
    expect(events).toHaveLength(0);
    parser.push('kId":"t1"}\n\n');

    expect(events).toEqual([{ topic: "task.reminder", id: "", payload: { taskId: "t1" } }]);
  });

  it("reassembles a frame split mid-line-terminator", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    parser.push("event: conversation.assigned\ndata: {}\n");
    expect(events).toHaveLength(0);
    parser.push("\n");

    expect(events).toEqual([{ topic: "conversation.assigned", id: "", payload: {} }]);
  });

  it("ignores heartbeat comment lines", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    parser.push(":heartbeat\n\nevent: conversation.assigned\ndata: {}\n\n");

    expect(events).toEqual([{ topic: "conversation.assigned", id: "", payload: {} }]);
  });

  it("drops a frame with malformed JSON without throwing", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    expect(() => parser.push("event: task.reminder\ndata: not-json\n\n")).not.toThrow();
    expect(events).toHaveLength(0);
  });

  it("parses multiple frames delivered in one push", () => {
    const events: SseEvent[] = [];
    const parser = createSseFrameParser((evt) => events.push(evt));

    parser.push("event: a\ndata: {}\n\nevent: b\ndata: {}\n\n");

    expect(events.map((e) => e.topic)).toEqual(["a", "b"]);
  });
});

function queryClientWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return createElement(QueryClientProvider, { client }, children);
}

describe("useSse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects with no authorization header — cookie auth carries the session", async () => {
    const emptyStream = new ReadableStream({
      start(controller) {
        controller.close();
      }
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(emptyStream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useSse(true), { wrapper: queryClientWrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/v1/events/stream");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();

    unmount();
  });

  it("does not connect while disabled (no authenticated user)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useSse(false), { wrapper: queryClientWrapper });

    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });

  it("invalidates conversations queries on a conversation.read event", async () => {
    // Flat payload — { conversationId } directly as `data`, matching how
    // api-gateway's sseHub.broadcast call for this route frames it (see the
    // handleEvent comment in use-sse.ts), not the { occurredAt, payload }
    // shape used for bus-forwarded topics.
    const frame = 'event: conversation.read\ndata: {"conversationId":"c1"}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }

    const { unmount } = renderHook(() => useSse(true), { wrapper });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] }));

    unmount();
  });

  it("invalidates conversations queries on a conversation.archived event", async () => {
    // Flat payload — { conversationId, archived } directly as `data`, matching
    // api-gateway's sseHub.broadcast call for POST /:id/archive.
    const frame = 'event: conversation.archived\ndata: {"conversationId":"c1","archived":true}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }

    const { unmount } = renderHook(() => useSse(true), { wrapper });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] }));

    unmount();
  });

  it("invalidates conversations queries on a conversation.pinned event", async () => {
    // Flat payload — { conversationId, pinned } directly as `data`, matching
    // api-gateway's sseHub.broadcast call for POST /:id/pin.
    const frame = 'event: conversation.pinned\ndata: {"conversationId":"c1","pinned":true}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }

    const { unmount } = renderHook(() => useSse(true), { wrapper });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] }));

    unmount();
  });
});

// ─── Reconnect delays: full jitter ───────────────────────────────────────────

describe("retryDelayMs", () => {
  it("never waits less than the 250ms floor, even when random() returns 0", () => {
    for (const attempt of [0, 1, 5, 30]) {
      expect(retryDelayMs(attempt, () => 0)).toBe(250);
    }
  });

  it("stays under the doubling cap and never reaches 30s", () => {
    const nearlyOne = () => 0.999_999;
    expect(retryDelayMs(0, nearlyOne)).toBe(999);
    expect(retryDelayMs(1, nearlyOne)).toBe(1_999);
    expect(retryDelayMs(3, nearlyOne)).toBe(7_999);
    expect(retryDelayMs(30, nearlyOne)).toBe(29_999);
  });

  it("spreads clients across the whole window between the floor and the cap", () => {
    expect(retryDelayMs(2, () => 0.25)).toBe(1_187);
    expect(retryDelayMs(2, () => 0.5)).toBe(2_125);
    expect(retryDelayMs(2, () => 0.75)).toBe(3_062);
  });
});

describe("cleanEndDelayMs", () => {
  it("picks a point in the 0–5s window", () => {
    expect(cleanEndDelayMs(() => 0)).toBe(0);
    expect(cleanEndDelayMs(() => 0.5)).toBe(2_500);
    expect(cleanEndDelayMs(() => 0.999_999)).toBe(4_999);
  });
});

// ─── Connection lifecycle: reconnect resync + HTTP status handling ──────────
//
// The gateway ends every stream at a lifetime cap (and when a user's sessions
// are revoked) and has no replay, so anything broadcast between one stream
// ending and the next being established is lost unless the client refetches.
// These tests drive the hook with fake timers and a fake clock (how long a
// stream stayed live decides its backoff) and pin Math.random, so the
// jittered reconnect schedule is asserted exactly instead of slept through.

const STREAM_URL = "/api/v1/events/stream";
const SESSION_PROBE_URL = "/auth/me";
const RESYNC_KEYS: QueryKey[] = [["conversations"], ["messages"], ["tasks"]];
/** Math.random() is pinned to this for every lifecycle test unless one overrides it. */
const PINNED_RANDOM = 0.5;
/** retryDelayMs(attempt) at random 0.5: 250 + 0.5 * (min(30s, 1s * 2^attempt) - 250). */
const BACKOFF = [625, 1_125, 2_125, 4_125, 8_125, 15_125];
/** cleanEndDelayMs() at random 0.5. */
const CLEAN_END_DELAY = 2_500;
const SESSION_USER = {
  id: "u1",
  email: "agent@acme.test",
  displayName: "Agent",
  roles: ["agent"],
  tenantId: "t1",
  tenant: { id: "t1", name: "Acme" }
};

function sseResponse(start: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response {
  return new Response(new ReadableStream<Uint8Array>({ start }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** A stream that ends the moment it opens (after delivering `frames`). */
function closedSseResponse(frames = ""): Response {
  return sseResponse((controller) => {
    if (frames) {
      controller.enqueue(new TextEncoder().encode(frames));
    }
    controller.close();
  });
}

/** A stream that stays open until the request is aborted, like a real fetch body. */
function openSseResponse(signal?: AbortSignal | null): Response {
  return sseResponse((controller) => {
    controller.enqueue(new TextEncoder().encode(": connected\n\n"));
    signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
  });
}

/** A stream that stays live for `ms` and then ends cleanly — the gateway's lifetime cap. */
function liveForSseResponse(ms: number, signal?: AbortSignal | null): Response {
  return sseResponse((controller) => {
    controller.enqueue(new TextEncoder().encode(": connected\n\n"));
    const timer = setTimeout(() => controller.close(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      controller.error(new DOMException("aborted", "AbortError"));
    });
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type FetchStep = (init: RequestInit | undefined) => Response | Promise<Response>;
const openStep: FetchStep = (init) => openSseResponse(init?.signal);
const closedStep: FetchStep = () => closedSseResponse();
const liveForStep =
  (ms: number): FetchStep =>
  (init) =>
    liveForSseResponse(ms, init?.signal);
const statusStep =
  (status: number, body: unknown = { error: "refused" }): FetchStep =>
  () =>
    jsonResponse(status, body);
const networkErrorStep: FetchStep = () => Promise.reject(new TypeError("Failed to fetch"));

/**
 * Serves stream requests from `streamSteps` and session probes (/auth/me)
 * from `probeSteps`, each in order, repeating its last step for every later call.
 */
function stubFetch(streamSteps: FetchStep[], probeSteps: FetchStep[] = []) {
  const served = { stream: 0, probe: 0 };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const isProbe = url === SESSION_PROBE_URL;
    const steps = isProbe ? probeSteps : streamSteps;
    const index = isProbe ? served.probe++ : served.stream++;
    const step = steps[Math.min(index, steps.length - 1)];
    if (!step) {
      throw new Error(`stubFetch has no step for ${url}`);
    }
    return Promise.resolve(step(init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof stubFetch>, url: string): number {
  return fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
}

function renderSse({ strict = false }: { strict?: boolean } = {}) {
  const client = new QueryClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const statuses: SseStatus[] = [];
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  const view = renderHook(
    () => {
      const status = useSse(true);
      statuses.push(status);
      return status;
    },
    { wrapper, reactStrictMode: strict }
  );
  return { ...view, statuses, invalidateSpy };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type InvalidateSpy = ReturnType<typeof renderSse>["invalidateSpy"];

function invalidatedKeys(spy: InvalidateSpy): QueryKey[] {
  return spy.mock.calls.map(([filters]) => filters?.queryKey as QueryKey);
}

/** The exact invalidateQueries calls `n` reconnect resyncs make. */
function resyncCalls(n: number) {
  return Array.from({ length: n }).flatMap(() =>
    RESYNC_KEYS.map((queryKey) => [{ queryKey }, { cancelRefetch: false }])
  );
}

function resyncCount(spy: InvalidateSpy): number {
  return spy.mock.calls.filter(([, options]) => options?.cancelRefetch === false).length / RESYNC_KEYS.length;
}

function statusesAfterFirstLive(statuses: SseStatus[]): SseStatus[] {
  const firstLive = statuses.indexOf("live");
  return firstLive === -1 ? [] : statuses.slice(firstLive);
}

describe("useSse connection lifecycle", () => {
  let randomSpy: MockInstance<() => number>;
  let debugSpy: MockInstance<(...data: unknown[]) => void>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(PINNED_RANDOM);
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setUnauthorizedHandler(() => undefined);
    localStorage.clear();
  });

  it("resyncs exactly the key families SSE events keep fresh", () => {
    expect(SSE_RESYNC_QUERY_KEYS).toEqual(RESYNC_KEYS);
  });

  it("every key family handleEvent invalidates is covered by the reconnect resync, and vice versa", async () => {
    // Drift guard: a new topic that invalidates a new key family must also be
    // refetched on reconnect, or events for it missed in the gap stay stale.
    const frames = [
      'event: task.reminder\ndata: {"title":"Call back"}\n\n',
      "event: conversation.assigned\ndata: {}\n\n",
      "event: conversation.team_assigned\ndata: {}\n\n",
      "event: conversation.state_changed\ndata: {}\n\n",
      'event: conversation.read\ndata: {"conversationId":"c1"}\n\n',
      'event: conversation.archived\ndata: {"conversationId":"c1","archived":true}\n\n',
      'event: conversation.pinned\ndata: {"conversationId":"c1","pinned":true}\n\n',
      'event: whatsapp.inbound.received\ndata: {"payload":{"conversationId":"c1"}}\n\n',
      'event: whatsapp.status.updated\ndata: {"payload":{"conversationId":"c1"}}\n\n',
      'event: media.stored\ndata: {"payload":{"conversationId":"c1"}}\n\n'
    ].join("");
    stubFetch([() => closedSseResponse(frames), openStep]);

    const { invalidateSpy, unmount } = renderSse();
    await advance(0);

    const eventFamilies = new Set(invalidatedKeys(invalidateSpy).map((key) => key[0]));
    const resyncFamilies = new Set(RESYNC_KEYS.map((key) => key[0]));
    expect(eventFamilies).toEqual(resyncFamilies);

    unmount();
  });

  it("does not resync on the first successful connection", async () => {
    const fetchMock = stubFetch([openStep]);

    const { result, invalidateSpy, unmount } = renderSse();
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("live");
    expect(invalidateSpy).not.toHaveBeenCalled();

    unmount();
  });

  it("resyncs every SSE-synced key family once per reconnect, without cancelling in-flight refetches", async () => {
    // Streams 1 and 2 each hit the lifetime cap after a minute; stream 3 stays open.
    const fetchMock = stubFetch([liveForStep(60_000), liveForStep(60_000), openStep]);

    const { result, invalidateSpy, unmount } = renderSse();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(CLEAN_END_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(1));

    await advance(60_000);
    await advance(CLEAN_END_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(2));
    expect(result.current).toBe("live");

    // Nothing further while the third stream stays open.
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(2));

    unmount();
  });

  // ─── Clean end of a live stream (the lifetime cap) ───

  it("a clean end of a live stream reads as connecting — never offline — until the next stream is live", async () => {
    stubFetch([liveForStep(600_000), openStep]);

    const { result, statuses, unmount } = renderSse();
    await advance(0);
    expect(result.current).toBe("live");

    await advance(600_000);
    expect(result.current).toBe("connecting");
    await advance(CLEAN_END_DELAY);
    expect(result.current).toBe("live");

    expect(statusesAfterFirstLive(statuses)).not.toContain("offline");

    unmount();
  });

  it("a clean end of a stream live for less than 30s also reads as connecting, never offline", async () => {
    // The short-lived path: the backoff is kept because the stream was not stable, but a clean end is still not an
    // outage. The stream stays live long enough for React to render "live", so the assertion has something to check.
    stubFetch([liveForStep(5_000), openStep]);

    const { result, statuses, unmount } = renderSse();
    await advance(0);
    expect(result.current).toBe("live");

    await advance(5_000);
    expect(result.current).toBe("connecting");
    expect(statusesAfterFirstLive(statuses)).toContain("connecting");
    expect(statusesAfterFirstLive(statuses)).not.toContain("offline");

    await advance(BACKOFF[0] ?? 0);
    expect(result.current).toBe("live");

    unmount();
  });

  it.each([
    [0.1, 500],
    [0.9, 4_500]
  ])(
    "after a clean end, reconnects at a random point in 0–5s (random %d → %ims) so capped cohorts drift apart",
    async (random, delay) => {
      randomSpy.mockReturnValue(random);
      const fetchMock = stubFetch([liveForStep(600_000), openStep]);

      const { unmount } = renderSse();
      await advance(0);
      await advance(600_000);

      await advance(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      unmount();
    }
  );

  // ─── Flapping and backoff reset ───

  it("a stream that flaps (2xx, then closes at once) backs off exponentially and resyncs at most once per 30s", async () => {
    const connectedAt: number[] = [];
    stubFetch([
      () => {
        connectedAt.push(Date.now());
        return closedSseResponse();
      }
    ]);

    const { statuses, invalidateSpy, unmount } = renderSse();
    await advance(0);
    for (let second = 0; second < 300; second += 1) {
      await advance(1_000);
    }

    const gaps = connectedAt.slice(1).map((at, index) => at - (connectedAt[index] ?? at));
    expect(gaps.slice(0, BACKOFF.length)).toEqual(BACKOFF);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(BACKOFF[0] ?? 0);
      expect(gap).toBeLessThan(30_000);
    }

    // 300s of flapping: one resync per 30s window at most, not one per reconnect.
    expect(connectedAt.length).toBeGreaterThan(12);
    expect(resyncCount(invalidateSpy)).toBeGreaterThanOrEqual(1);
    expect(resyncCount(invalidateSpy)).toBeLessThanOrEqual(300 / 30 + 1);
    expect(invalidateSpy.mock.calls.every(([, options]) => options?.cancelRefetch === false)).toBe(true);
    // A stream that closes the moment it opens never renders "live" (React batches it with the next status), so
    // check from the first "connecting" instead: once the hook starts, a clean-ending flap never shows "offline".
    const fromFirstConnect = statuses.slice(statuses.indexOf("connecting"));
    expect(fromFirstConnect.length).toBeGreaterThan(1);
    expect(fromFirstConnect).not.toContain("offline");

    unmount();
  });

  it("a stream that ended before staying live for 30s does not reset the backoff", async () => {
    const fetchMock = stubFetch([closedStep, closedStep, liveForStep(29_000), closedStep]);

    const { unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);
    await advance(BACKOFF[1] ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await advance(29_000);
    await advance((BACKOFF[2] ?? 0) - 1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    unmount();
  });

  it("a stream that stayed live for 30s resets the backoff", async () => {
    const fetchMock = stubFetch([closedStep, closedStep, liveForStep(30_000), statusStep(503), openStep]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { result, unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);
    await advance(BACKOFF[1] ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await advance(30_000);
    await advance(CLEAN_END_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The 503 after the stable stream backs off from the first step again.
    await advance((BACKOFF[0] ?? 0) - 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current).toBe("live");

    unmount();
  });

  // ─── 401: confirm with the session endpoint before signing out ───

  it("a 401 the session probe confirms signs out exactly once and stops reconnecting", async () => {
    writeSession({ tenantId: "t1", tenantName: "Acme", role: "agent" });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch(
      [statusStep(401, { error: "unauthenticated" })],
      [statusStep(401, { error: "Session expired or invalid" })]
    );

    const { result, statuses, invalidateSpy, unmount } = renderSse();
    await advance(0);
    await advance(120_000);

    expect(callsTo(fetchMock, STREAM_URL)).toBe(1);
    expect(callsTo(fetchMock, SESSION_PROBE_URL)).toBe(1);
    expect(statuses).not.toContain("live");
    expect(result.current).toBe("offline");
    // request() signed out on the probe's 401; the hook must not do it again.
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(localStorage.getItem("hf_tname")).toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(vi.getTimerCount()).toBe(0);

    unmount();
  });

  it.each([
    ["a 503", statusStep(503, { error: "unavailable" })],
    ["a network error", networkErrorStep]
  ])(
    "a 401 whose session probe fails with %s is treated as transient: no sign-out, normal backoff",
    async (_label, probe) => {
      writeSession({ tenantId: "t1", tenantName: "Acme", role: "agent" });
      const onUnauthorized = vi.fn();
      setUnauthorizedHandler(onUnauthorized);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetchMock = stubFetch([statusStep(401, { error: "unauthenticated" }), openStep], [probe]);

      const { result, unmount } = renderSse();
      await advance(0);
      expect(callsTo(fetchMock, STREAM_URL)).toBe(1);
      expect(callsTo(fetchMock, SESSION_PROBE_URL)).toBe(1);
      expect(result.current).toBe("offline");

      await advance((BACKOFF[0] ?? 0) - 1);
      expect(callsTo(fetchMock, STREAM_URL)).toBe(1);
      await advance(1);
      expect(callsTo(fetchMock, STREAM_URL)).toBe(2);
      expect(result.current).toBe("live");

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(localStorage.getItem("hf_tname")).toBe("Acme");

      unmount();
    }
  );

  it("a 401 while the session probe says the session is valid keeps reconnecting with backoff", async () => {
    writeSession({ tenantId: "t1", tenantName: "Acme", role: "agent" });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch(
      [statusStep(401, { error: "unauthenticated" }), statusStep(401, { error: "unauthenticated" }), openStep],
      [statusStep(200, SESSION_USER)]
    );

    const { result, invalidateSpy, unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);
    expect(callsTo(fetchMock, STREAM_URL)).toBe(2);
    expect(callsTo(fetchMock, SESSION_PROBE_URL)).toBe(2);

    await advance((BACKOFF[1] ?? 0) - 1);
    expect(callsTo(fetchMock, STREAM_URL)).toBe(2);
    await advance(1);
    expect(callsTo(fetchMock, STREAM_URL)).toBe(3);
    expect(result.current).toBe("live");
    // Back after failed attempts, so the gap is refetched.
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(1));

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(localStorage.getItem("hf_tname")).toBe("Acme");

    unmount();
  });

  it("a 403 never goes live and stops reconnecting without probing or signing the user out", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch([statusStep(403, { error: "no_roles_assigned" })]);

    const { result, statuses, unmount } = renderSse();
    await advance(0);
    await advance(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callsTo(fetchMock, SESSION_PROBE_URL)).toBe(0);
    expect(statuses).not.toContain("live");
    expect(result.current).toBe("offline");
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("403"));
    expect(vi.getTimerCount()).toBe(0);

    unmount();
  });

  // ─── Failed attempts ───

  it.each([500, 503, 429])(
    "a %i retries with jittered exponential backoff, logs each retry, and never shows live",
    async (status) => {
      const fetchMock = stubFetch([statusStep(status, { error: "unavailable" })]);

      const { result, statuses, invalidateSpy, unmount } = renderSse();
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current).toBe("offline");
      expect(debugSpy).toHaveBeenLastCalledWith(expect.stringContaining(`HTTP ${status}`));
      expect(debugSpy).toHaveBeenLastCalledWith(expect.stringContaining("retry 1 in 625ms"));

      await advance((BACKOFF[0] ?? 0) - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(debugSpy).toHaveBeenLastCalledWith(expect.stringContaining("retry 2 in 1125ms"));

      await advance((BACKOFF[1] ?? 0) - 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await advance(BACKOFF[2] ?? 0);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      expect(statuses).not.toContain("live");
      expect(invalidateSpy).not.toHaveBeenCalled();

      unmount();
    }
  );

  it("logs retries at debug, then at warn once the stream has failed five times in a row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch([statusStep(503, { error: "unavailable" })]);

    const { unmount } = renderSse();
    await advance(0);
    for (const delay of BACKOFF.slice(0, 3)) {
      await advance(delay);
    }
    expect(debugSpy).toHaveBeenCalledTimes(4);
    expect(warn).not.toHaveBeenCalled();

    await advance(BACKOFF[3] ?? 0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retry 5 in 8125ms"));

    unmount();
  });

  it("a network error backs off and never shows live", async () => {
    const fetchMock = stubFetch([networkErrorStep]);

    const { result, statuses, invalidateSpy, unmount } = renderSse();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("offline");
    expect(debugSpy).toHaveBeenLastCalledWith(expect.stringContaining("Failed to fetch"));

    await advance((BACKOFF[0] ?? 0) - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(BACKOFF[1] ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(statuses).not.toContain("live");
    expect(invalidateSpy).not.toHaveBeenCalled();

    unmount();
  });

  it.each([401, 403, 503])("a %i whose body looks like SSE frames is never parsed as a stream", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const frames =
      'event: conversation.assigned\ndata: {}\n\nevent: task.reminder\ndata: {"title":"x"}\n\n' +
      'event: whatsapp.inbound.received\ndata: {"payload":{"conversationId":"c1"}}\n\n';
    stubFetch(
      [() => new Response(frames, { status, headers: { "content-type": "text/event-stream" } })],
      [statusStep(200, SESSION_USER)]
    );

    const { statuses, invalidateSpy, unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(statuses).not.toContain("live");

    unmount();
  });

  it("the first successful connection after failed attempts resyncs once (the failed window can miss events)", async () => {
    const fetchMock = stubFetch([statusStep(502, { error: "bad gateway" }), openStep]);

    const { result, invalidateSpy, unmount } = renderSse();
    await advance(0);
    expect(invalidateSpy).not.toHaveBeenCalled();

    await advance(BACKOFF[0] ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("live");
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(1));

    unmount();
  });

  // ─── StrictMode ───

  it("under StrictMode's double-mounted effect, one stream stays subscribed and a reconnect resyncs once", async () => {
    const fetchMock = stubFetch([liveForStep(60_000), liveForStep(60_000), openStep]);

    const { result, invalidateSpy, unmount } = renderSse({ strict: true });
    await advance(0);

    // Positive control: StrictMode really mounted, cleaned up and re-mounted
    // the effect — the first subscription was aborted, the second is live.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.signal?.aborted)).toEqual([true, false]);
    expect(result.current).toBe("live");
    expect(invalidateSpy).not.toHaveBeenCalled();

    await advance(60_000);
    await advance(CLEAN_END_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(1));

    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(1));

    unmount();
  });

  // ─── Unmount ───

  it("unmount aborts the live stream", async () => {
    const fetchMock = stubFetch([openStep]);

    const { result, unmount } = renderSse();
    await advance(0);
    expect(result.current).toBe("live");

    unmount();
    await advance(60_000);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unmount cancels a pending retry", async () => {
    const fetchMock = stubFetch([closedStep]);

    const { unmount } = renderSse();
    await advance(0);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unmount cancels a deferred resync", async () => {
    // Two quick reconnects: the first resyncs at once, the second's resync is
    // deferred to the end of the 30s window.
    stubFetch([closedStep, closedStep, openStep]);

    const { invalidateSpy, unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);
    await advance(BACKOFF[1] ?? 0);
    expect(resyncCount(invalidateSpy)).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);

    expect(resyncCount(invalidateSpy)).toBe(1);
  });

  it("a resync deferred by the 30s guard still runs, so the later gap is refetched too", async () => {
    stubFetch([closedStep, closedStep, openStep]);

    const { invalidateSpy, unmount } = renderSse();
    await advance(0);
    await advance(BACKOFF[0] ?? 0);
    expect(resyncCount(invalidateSpy)).toBe(1);
    await advance(BACKOFF[1] ?? 0);
    expect(resyncCount(invalidateSpy)).toBe(1);

    // The first resync ran at t=625ms; the deferred one is due 30s later.
    await advance(30_000 - (BACKOFF[1] ?? 0) - 1);
    expect(resyncCount(invalidateSpy)).toBe(1);
    await advance(1);
    expect(resyncCount(invalidateSpy)).toBe(2);
    expect(invalidateSpy.mock.calls).toEqual(resyncCalls(2));

    unmount();
  });
});
