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
});
