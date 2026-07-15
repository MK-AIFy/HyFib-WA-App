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
        scope="conversations"
        onScopeChange={() => {}}
        onSelectConversation={() => {}}
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
      scope="conversations"
      onScopeChange={() => {}}
      onSelectConversation={() => {}}
    />
  );
}

/**
 * Mirrors InboxPage's real lifted-state wiring for `search`/`scope`, needed
 * for the scope-toggle tests below: a real `useState` (not a no-op
 * callback) so typing into the search box and clicking the toggle actually
 * re-render with the new values, like InboxPage does in production.
 */
function ScopeToggleHarness() {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"conversations" | "messages">("conversations");
  return (
    <ConversationList
      onSelect={() => {}}
      state="all"
      onStateChange={() => {}}
      search={search}
      onSearchChange={setSearch}
      q={search}
      archived={false}
      onArchivedChange={() => {}}
      scope={scope}
      onScopeChange={setScope}
      onSelectConversation={() => {}}
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

  it("renders a pin icon for a conversation with pinnedAt set, exposed to assistive tech as a named image (review finding 3)", async () => {
    renderList([
      conv({ id: "c1", unreadCount: 0, contactName: "Pinned Contact", pinnedAt: "2026-07-12T00:00:00.000Z" })
    ]);

    await screen.findByText("Pinned Contact");
    // `role="img"` on the bare lucide SVG is what makes `aria-label="Pinned"`
    // reliably reach the accessibility tree (an SVG with no role has no
    // implicit ARIA role, so an aria-label alone is not dependably exposed
    // by every screen reader/AT combination) — assert via getByRole, not
    // just getByLabelText, since the latter matches the aria-label attribute
    // directly regardless of role and would pass even without the fix.
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("renders no pin icon for a conversation without pinnedAt", async () => {
    renderList([conv({ id: "c1", unreadCount: 0, contactName: "Unpinned Contact" })]);

    await screen.findByText("Unpinned Contact");
    expect(screen.queryByRole("img", { name: "Pinned" })).not.toBeInTheDocument();
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

describe("ConversationList — scope toggle (Task 26)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render the scope toggle while the search box is empty", async () => {
    renderList([]);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "Messages" })).not.toBeInTheDocument();
  });

  it("renders the scope toggle once the search box is non-empty, and switching to Messages swaps the panel", async () => {
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [], total: 0, limit: 20, offset: 0 });
      }
      return Promise.resolve({ items: [conv({ id: "c1", unreadCount: 0, contactName: "Jane Doe" })] });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ScopeToggleHarness />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));
    expect(screen.queryByRole("tab", { name: "Messages" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Search conversations"), "jane");

    expect(await screen.findByRole("tab", { name: "Messages" })).toBeInTheDocument();
    // Default scope ("Conversations") still renders the plain conversation list.
    expect(screen.getByRole("listbox", { name: "Conversations" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Messages" }));

    expect(await screen.findByRole("listbox", { name: "Message search results" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Conversations" })).not.toBeInTheDocument();
  });
});
