import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useMessageSearch } from "./use-message-search";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("useMessageSearch — min-length gating (Task 26)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch for a 1-character query (below the backend's min length)", async () => {
    const getMock = vi.spyOn(api, "get").mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMessageSearch("a"), { wrapper: wrapperFor(client) });

    expect(result.current.fetchStatus).toBe("idle");
    // Give any (incorrect) fetch a tick to have fired before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMock).not.toHaveBeenCalled();
  });

  it("fetches with the encoded q once the query reaches 2 characters", async () => {
    const getMock = vi.spyOn(api, "get").mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useMessageSearch("hi there"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/messages/search?q=hi%20there"));
  });

  it("trims whitespace-only input to below the 2-char minimum (no fetch)", async () => {
    const getMock = vi.spyOn(api, "get").mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMessageSearch("  a  "), { wrapper: wrapperFor(client) });

    expect(result.current.fetchStatus).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMock).not.toHaveBeenCalled();
  });
});
