import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { useArchiveConversation, useConversations, useMarkRead, usePinConversation } from "./use-conversations";

function conv(overrides: Partial<Conversation> & { id: string; unreadCount: number }): Conversation {
  return {
    tenantId: "t1",
    contactId: "ct1",
    channelId: "ch1",
    contactPhone: "+15551234567",
    state: "open",
    ...overrides
  };
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("useMarkRead — optimistic cache mutation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("zeroes unreadCount for the target conversation in every cached conversations query, leaving siblings and totals untouched", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "c1" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Two cache entries for two different tabs, both containing "c1" — this
    // mirrors what ConversationList's own useConversations(state) call
    // populates for whichever tab is currently open, plus whatever other
    // tabs happen to still be cached from an earlier visit.
    const allEntry = {
      items: [conv({ id: "c1", unreadCount: 3 }), conv({ id: "c2", unreadCount: 5 })],
      total: 2
    };
    const openEntry = {
      items: [conv({ id: "c1", unreadCount: 3, state: "open" })],
      total: 1
    };
    client.setQueryData(["conversations", { state: "all" }], allEntry);
    client.setQueryData(["conversations", { state: "open" }], openEntry);

    const { result } = renderHook(() => useMarkRead(), { wrapper: wrapperFor(client) });

    result.current.mutate("c1");

    await waitFor(() => {
      const after = client.getQueryData<typeof allEntry>(["conversations", { state: "all" }]);
      expect(after?.items.find((c) => c.id === "c1")?.unreadCount).toBe(0);
    });

    // Both cache entries updated for the target conversation...
    const afterAll = client.getQueryData<typeof allEntry>(["conversations", { state: "all" }]);
    const afterOpen = client.getQueryData<typeof openEntry>(["conversations", { state: "open" }]);
    expect(afterAll?.items.find((c) => c.id === "c1")?.unreadCount).toBe(0);
    expect(afterOpen?.items.find((c) => c.id === "c1")?.unreadCount).toBe(0);

    // ...but sibling fields are untouched: the other conversation in the
    // "all" entry keeps its own unreadCount, and both entries' `total`
    // counts are unchanged (no rows added/removed, just the one field).
    expect(afterAll?.items.find((c) => c.id === "c2")?.unreadCount).toBe(5);
    expect(afterAll?.total).toBe(2);
    expect(afterOpen?.total).toBe(1);
  });
});

describe("useConversations — query string construction and query-key compatibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits q/archived from the request URL when unset, and folds them in once set", async () => {
    const getMock = vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result, rerender } = renderHook<ReturnType<typeof useConversations>, { q?: string; archived?: boolean }>(
      ({ q, archived }) => useConversations("all", q, archived),
      { wrapper: wrapperFor(client), initialProps: { q: undefined, archived: undefined } }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenLastCalledWith("/api/v1/conversations");

    rerender({ q: "jane", archived: undefined });
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith("/api/v1/conversations?q=jane"));

    rerender({ q: "jane", archived: true });
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith("/api/v1/conversations?q=jane&archived=true"));

    rerender({ q: undefined, archived: true });
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith("/api/v1/conversations?archived=true"));
  });

  it("hashes { state, q: undefined, archived: undefined } identically to the pre-Task-24 { state } key, so old cache entries keep matching", () => {
    // TanStack Query's default hashKey serializes the key with JSON.stringify,
    // which drops object properties whose value is `undefined` — this is the
    // mechanism the CRITICAL wiring constraint relies on for backward
    // compatibility with existing ["conversations", { state }] cache entries
    // (see useMarkRead's optimistic update above, which still targets that
    // shorter key shape).
    const client = new QueryClient();
    client.setQueryData(["conversations", { state: "all" }], { items: [{ id: "legacy" }] });

    const viaNewShape = client.getQueryData(["conversations", { state: "all", q: undefined, archived: undefined }]);

    expect(viaNewShape).toEqual({ items: [{ id: "legacy" }] });
  });
});

describe("useArchiveConversation — settle-then-invalidate mutation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs {archived} to /:id/archive with the (id, archived) variables and invalidates conversations queries on settle", async () => {
    const postMock = vi
      .spyOn(api, "post")
      .mockResolvedValue({ status: "archived", conversationId: "c1", archived: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useArchiveConversation(), { wrapper: wrapperFor(client) });
    result.current.mutate({ id: "c1", archived: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/archive", { archived: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });
});

describe("usePinConversation — settle-then-invalidate mutation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs {pinned} to /:id/pin with the (id, pinned) variables and invalidates conversations queries on settle", async () => {
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "pinned", conversationId: "c1", pinned: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => usePinConversation(), { wrapper: wrapperFor(client) });
    result.current.mutate({ id: "c1", pinned: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/pin", { pinned: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });
});
