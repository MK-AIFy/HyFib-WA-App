import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseFrameParser, useSse, type SseEvent } from "./use-sse";

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
});
