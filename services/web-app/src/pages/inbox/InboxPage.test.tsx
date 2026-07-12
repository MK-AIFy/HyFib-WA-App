import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { InboxPage } from "./InboxPage";

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

const CONVERSATIONS = [
  conv({ id: "c-unread", unreadCount: 3, contactName: "Has Unread" }),
  conv({ id: "c-read", unreadCount: 0, contactName: "No Unread" })
];

function renderInbox() {
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/messages")) return Promise.resolve({ items: [] });
    if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
    if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InboxPage />
    </QueryClientProvider>
  );
  return { postMock };
}

describe("InboxPage — mark-read on open", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires POST .../read exactly once when selecting a conversation with unreadCount > 0", async () => {
    const { postMock } = renderInbox();
    const user = userEvent.setup();

    await user.click(await screen.findByText("Has Unread"));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-unread/read", {}));
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire POST .../read when selecting a conversation with unreadCount 0", async () => {
    const { postMock } = renderInbox();
    const user = userEvent.setup();

    await user.click(await screen.findByText("No Unread"));

    // Give any (incorrect) effect a tick to have fired before asserting absence.
    // Scoped to role="option" (the list row) — after selection, "No Unread"
    // also appears in ChatPane's header, so a plain text query is ambiguous.
    const selected = await screen.findByRole("option", { selected: true });
    expect(selected).toHaveTextContent("No Unread");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("re-fires mark-read on a fresh inbound for a conversation selected from a non-default (filtered) tab", async () => {
    // Regression for review finding 1: the conversation below only exists in
    // the "closed" tab's query results — the unfiltered "all" tab (server's
    // default top-25 page) never contains it. Before the fix, InboxPage
    // always read freshness off `useConversations("all")`, so this row would
    // never be found there and the mark-read re-fire on a new inbound would
    // silently never happen.
    let closedItems = [conv({ id: "c-closed", unreadCount: 2, contactName: "Closed Unread", state: "closed" })];
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path === "/api/v1/conversations?state=closed") return Promise.resolve({ items: closedItems });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: [] }); // "all" tab: empty
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    // Mock POST to actually persist the read, like the real backend would —
    // otherwise a static GET mock would "bounce" unreadCount back up on the
    // post-mutation refetch and produce a false-positive re-fire.
    const postMock = vi.spyOn(api, "post").mockImplementation((path: string) => {
      closedItems = closedItems.map((c) => (path.includes(c.id) ? { ...c, unreadCount: 0 } : c));
      return Promise.resolve({ status: "read", conversationId: "" });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Closed" }));
    await user.click(await screen.findByText("Closed Unread"));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-closed/read", {});

    // Simulate a new inbound bumping unreadCount back up — landing directly
    // in the SAME `["conversations", { state: "closed" }]` cache entry
    // ConversationList itself renders from (what an SSE-triggered
    // invalidate+refetch would ultimately produce).
    client.setQueryData(["conversations", { state: "closed" }], {
      items: [{ ...closedItems[0], unreadCount: 1 }]
    });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock).toHaveBeenLastCalledWith("/api/v1/conversations/c-closed/read", {});
  });
});
