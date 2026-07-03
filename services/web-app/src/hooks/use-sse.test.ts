import { describe, expect, it } from "vitest";
import { createSseFrameParser, type SseEvent } from "./use-sse";

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
