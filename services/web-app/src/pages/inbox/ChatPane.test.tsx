import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { ChatPane } from "./ChatPane";

function conv(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    tenantId: "t1",
    contactId: "ct1",
    channelId: "ch1",
    contactName: "Jane Doe",
    contactPhone: "+15551234567",
    state: "open",
    unreadCount: 0,
    ...overrides
  };
}

function renderChatPane(conversation: Conversation) {
  const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/messages")) return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "ok" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChatPane conversation={conversation} />
    </QueryClientProvider>
  );
  return { getMock, postMock };
}

describe("ChatPane — pin/archive header controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'Pin conversation' / 'Archive conversation' for a conversation that is neither pinned nor archived", async () => {
    renderChatPane(conv({ id: "c1" }));

    expect(await screen.findByRole("button", { name: "Pin conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive conversation" })).toBeInTheDocument();
  });

  it("clicking 'Pin conversation' fires usePinConversation with {id, pinned: true}", async () => {
    const { postMock } = renderChatPane(conv({ id: "c1" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Pin conversation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/pin", { pinned: true }));
  });

  it("clicking 'Unpin conversation' (already pinned) fires usePinConversation with {id, pinned: false}", async () => {
    const { postMock } = renderChatPane(conv({ id: "c1", pinnedAt: "2026-07-12T00:00:00.000Z" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Unpin conversation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/pin", { pinned: false }));
  });

  it("clicking 'Archive conversation' fires useArchiveConversation with {id, archived: true}", async () => {
    const { postMock } = renderChatPane(conv({ id: "c1" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Archive conversation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/archive", { archived: true }));
  });

  it("clicking 'Unarchive conversation' (already archived) fires useArchiveConversation with {id, archived: false}", async () => {
    const { postMock } = renderChatPane(conv({ id: "c1", archivedAt: "2026-07-12T00:00:00.000Z" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Unarchive conversation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/archive", { archived: false }));
  });

  it("pin and archive mutations are independent — clicking one does not fire the other", async () => {
    const { postMock } = renderChatPane(conv({ id: "c1" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Pin conversation" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/pin", { pinned: true }));
    expect(postMock).not.toHaveBeenCalledWith("/api/v1/conversations/c1/archive", expect.anything());
  });
});
