import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSessionWindowOpen, SESSION_WINDOW_MS, useSessionWindow } from "./use-session-window";

describe("isSessionWindowOpen", () => {
  const now = new Date("2026-07-15T12:00:00.000Z").getTime();

  it("is open just under 24h", () => {
    const at = new Date(now - (SESSION_WINDOW_MS - 60_000)).toISOString();
    expect(isSessionWindowOpen(at, now)).toBe(true);
  });

  it("is closed at exactly 24h and beyond", () => {
    expect(isSessionWindowOpen(new Date(now - SESSION_WINDOW_MS).toISOString(), now)).toBe(false);
    expect(isSessionWindowOpen(new Date(now - SESSION_WINDOW_MS - 60_000).toISOString(), now)).toBe(false);
  });

  it("is closed for absent or unparseable timestamps", () => {
    expect(isSessionWindowOpen(undefined, now)).toBe(false);
    expect(isSessionWindowOpen("not-a-date", now)).toBe(false);
  });
});

describe("useSessionWindow", () => {
  afterEach(() => vi.useRealTimers());

  it("flips from open to closed as the minute clock ticks past 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const base = Date.now();
    const lastInbound = new Date(base - (SESSION_WINDOW_MS - 10 * 60_000)).toISOString(); // 23h50m ago

    const { result } = renderHook(() => useSessionWindow(lastInbound));
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15 * 60_000); // +15m → 24h05m since inbound
    });
    expect(result.current).toBe(false);
  });
});
