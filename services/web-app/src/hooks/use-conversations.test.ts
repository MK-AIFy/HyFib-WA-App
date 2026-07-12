import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { useMarkRead } from "./use-conversations";

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
