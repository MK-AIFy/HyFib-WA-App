import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageSearchResult } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { MessageSearchResults } from "./MessageSearchResults";

function result(overrides: Partial<MessageSearchResult> & { id: string }): MessageSearchResult {
  return {
    conversationId: "conv-1",
    direction: "inbound",
    status: "delivered",
    createdAt: "2026-07-12T00:00:00.000Z",
    text: "Hello world",
    ...overrides
  };
}

function renderResults(items: MessageSearchResult[], onSelectConversation = vi.fn()) {
  vi.spyOn(api, "get").mockResolvedValue({ items, total: items.length, limit: 20, offset: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageSearchResults q="world" onSelectConversation={onSelectConversation} />
    </QueryClientProvider>
  );
  return { onSelectConversation };
}

describe("MessageSearchResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders contact name, the matched fragment highlighted, and no direction prefix for an inbound message", async () => {
    renderResults([result({ id: "m1", contactName: "Jane Doe", text: "Hello world", direction: "inbound" })]);

    await screen.findByText("Jane Doe");
    // Highlighted fragment: the matched substring is wrapped in its own node ("world"),
    // with the surrounding text ("Hello ") as a sibling — not one flat text node.
    expect(screen.getByText("world", { selector: "mark" })).toBeInTheDocument();
    expect(screen.queryByText(/^You:/)).not.toBeInTheDocument();
  });

  it("prefixes outbound messages with 'You: '", async () => {
    renderResults([result({ id: "m1", contactName: "Jane Doe", text: "Hello world", direction: "outbound" })]);

    await screen.findByText("Jane Doe");
    expect(screen.getByText(/^You:/)).toBeInTheDocument();
  });

  it("falls back to phone, then 'Unknown', when contactName is missing", async () => {
    renderResults([result({ id: "m1", contactPhone: "+15551234567", text: "Hello world" })]);
    await screen.findByText("+15551234567");

    vi.restoreAllMocks();
    renderResults([result({ id: "m2", text: "Hello world" })]);
    await screen.findByText("Unknown");
  });

  it("calls onSelectConversation with the result's conversationId when clicked", async () => {
    const { onSelectConversation } = renderResults([
      result({ id: "m1", conversationId: "conv-42", contactName: "Jane Doe", text: "Hello world" })
    ]);
    const user = userEvent.setup();

    await user.click(await screen.findByText("Jane Doe"));

    expect(onSelectConversation).toHaveBeenCalledWith("conv-42");
    expect(onSelectConversation).toHaveBeenCalledTimes(1);
  });

  it("renders the 'No messages found' empty state when items is empty", async () => {
    renderResults([]);
    expect(await screen.findByText("No messages found")).toBeInTheDocument();
  });

  it("does not throw and highlights nothing extra for a query containing regex-special characters", async () => {
    // Guards against `new RegExp(q)` — a query like "a(b" would throw a
    // SyntaxError (unterminated group) if the highlighter ever built a
    // RegExp straight from user input instead of using plain indexOf.
    vi.spyOn(api, "get").mockResolvedValue({
      items: [result({ id: "m1", contactName: "Jane Doe", text: "code: a(b) works" })],
      total: 1,
      limit: 20,
      offset: 0
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <MessageSearchResults q="a(b" onSelectConversation={vi.fn()} />
        </QueryClientProvider>
      )
    ).not.toThrow();

    await screen.findByText("Jane Doe");
    expect(screen.getByText("a(b", { selector: "mark" })).toBeInTheDocument();
  });
});
