import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useTypingIndicator } from "./use-typing-indicator";

describe("useTypingIndicator", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts on the first call and throttles within 20s, then fires again after", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const postMock = vi.spyOn(api, "post").mockResolvedValue({});
    const { result } = renderHook(() => useTypingIndicator("c1"));

    result.current();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/typing");

    nowSpy.mockReturnValue(1_000_000 + 5_000);
    result.current();
    expect(postMock).toHaveBeenCalledTimes(1); // throttled

    nowSpy.mockReturnValue(1_000_000 + 21_000);
    result.current();
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("swallows request errors without throwing or leaving an unhandled rejection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.spyOn(api, "post").mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useTypingIndicator("c1"));

    expect(() => result.current()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("resets the throttle when the conversation changes", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const postMock = vi.spyOn(api, "post").mockResolvedValue({});
    const { result, rerender } = renderHook(({ id }) => useTypingIndicator(id), { initialProps: { id: "c1" } });

    result.current();
    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/typing");
    postMock.mockClear();

    rerender({ id: "c2" });
    result.current();
    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c2/typing");
  });
});
