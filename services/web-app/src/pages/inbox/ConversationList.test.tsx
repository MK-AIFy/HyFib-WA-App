import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { ConversationList } from "./ConversationList";

function conv(overrides: Partial<Conversation> & { id: string; unreadCount: number }): Conversation {
  return {
    tenantId: "t1",
    contactId: "ct1",
    channelId: "ch1",
    contactName: "Jane Doe",
    contactPhone: "+15551234567",
    state: "open",
    ...overrides
  };
}

function renderList(items: Conversation[]) {
  vi.spyOn(api, "get").mockResolvedValue({ items });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationList
        onSelect={() => {}}
        state="all"
        onStateChange={() => {}}
        search=""
        onSearchChange={() => {}}
        q=""
        archived={false}
        onArchivedChange={() => {}}
      />
    </QueryClientProvider>
  );
}

/**
 * Mirrors how InboxPage actually owns `archived` (a real useState, re-rendering
 * ConversationList with the new value) rather than a no-op callback — needed
 * for the toggle test below, which asserts on the resulting *second* fetch.
 */
function ArchivedToggleHarness() {
  const [archived, setArchived] = useState(false);
  return (
    <ConversationList
      onSelect={() => {}}
      state="all"
      onStateChange={() => {}}
      search=""
      onSearchChange={() => {}}
      q=""
      archived={archived}
      onArchivedChange={setArchived}
    />
  );
}

describe("ConversationList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the numeric unread badge with an accessible name for a conversation with unreadCount 3", async () => {
    renderList([conv({ id: "c1", unreadCount: 3, contactName: "Has Unread" })]);

    await screen.findByText("Has Unread");
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByLabelText("3 unread messages")).toBeInTheDocument();
  });

  it("renders no badge for a conversation with unreadCount 0", async () => {
    renderList([conv({ id: "c1", unreadCount: 0, contactName: "No Unread" })]);

    await screen.findByText("No Unread");
    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders a pin icon for a conversation with pinnedAt set", async () => {
    renderList([
      conv({ id: "c1", unreadCount: 0, contactName: "Pinned Contact", pinnedAt: "2026-07-12T00:00:00.000Z" })
    ]);

    await screen.findByText("Pinned Contact");
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("renders no pin icon for a conversation without pinnedAt", async () => {
    renderList([conv({ id: "c1", unreadCount: 0, contactName: "Unpinned Contact" })]);

    await screen.findByText("Unpinned Contact");
    expect(screen.queryByLabelText("Pinned")).not.toBeInTheDocument();
  });

  it("does not sort rows client-side — renders server order, pinned or not", async () => {
    // Server pre-sorts pinned-first (Task 23); the client must render items
    // in the order the API returned them, not re-sort locally.
    renderList([
      conv({ id: "c1", unreadCount: 0, contactName: "Second Row" }),
      conv({ id: "c2", unreadCount: 0, contactName: "First Row (pinned)", pinnedAt: "2026-07-12T00:00:00.000Z" })
    ]);

    const rows = await screen.findAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Second Row"),
      expect.stringContaining("First Row (pinned)")
    ]);
  });

  it("adds archived=true to the request when the archived toggle is turned on", async () => {
    const getMock = vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ArchivedToggleHarness />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));

    await user.click(screen.getByRole("button", { name: "Show archived conversations" }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?archived=true"));
  });
});
