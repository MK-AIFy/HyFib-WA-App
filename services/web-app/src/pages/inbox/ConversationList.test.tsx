import { render, screen } from "@testing-library/react";
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
      <ConversationList onSelect={() => {}} state="all" onStateChange={() => {}} />
    </QueryClientProvider>
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
});
