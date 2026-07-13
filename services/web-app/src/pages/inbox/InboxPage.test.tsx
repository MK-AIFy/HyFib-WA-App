import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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

describe("InboxPage — no duplicate mark-read across a query-key transition (review finding 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fires exactly one POST .../read when the selected conversation's row is still zeroed after the debounced search query transitions to a never-fetched key", async () => {
    // Reproduction from the reviewer: select an unread conversation (first
    // POST fires) -> type into search -> advance the 300ms debounce (this
    // flips the query key from {state:"all", q:undefined} to a NEVER-FETCHED
    // {state:"all", q:"has"} key) -> a SECOND POST must NOT fire.
    //
    // Root cause (pre-fix): without `placeholderData`, TanStack Query makes
    // `data` transiently `undefined` for a brand-new key. `freshActive`
    // (`data?.items.find(...)`) becomes undefined, so
    // `selectedUnreadCount = freshActive?.unreadCount ?? active?.unreadCount ?? 0`
    // falls back to `active.unreadCount` — the STALE click-time snapshot
    // (3, captured in `setActive(c)` and never updated), not the
    // already-zeroed live value. That flips selectedUnreadCount 0 -> 3,
    // and the mark-read effect (deps: [selectedId, selectedUnreadCount])
    // re-fires.
    let items = [conv({ id: "c-unread", unreadCount: 3, contactName: "Has Unread" })];
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    // Mock POST to actually persist the read (mirrors the "closed tab"
    // regression test above) so the cache reflects real zeroed state before
    // we transition the query key, matching the reviewer's repro precisely.
    const postMock = vi.spyOn(api, "post").mockImplementation((path: string) => {
      items = items.map((c) => (path.includes(c.id) ? { ...c, unreadCount: 0 } : c));
      return Promise.resolve({ status: "read", conversationId: "" });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await user.click(await screen.findByText("Has Unread"));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // Let the mutation's onSettled invalidate + refetch land, so the cache
    // for the CURRENT (pre-search) key is stably zeroed before we type —
    // the unread badge disappearing is the observable signal of that.
    await waitFor(() => expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument());

    const input = await screen.findByLabelText("Search conversations");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(input, { target: { value: "has" } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?q=has"));
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});

describe("InboxPage — server-side search, archived folder wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("typing in the search box, after the debounce window, refetches with q= in the request URL (and not before)", async () => {
    // Render and settle the initial fetch on REAL timers first — faking
    // globals during React's initial mount/effect flush is what causes this
    // kind of test to hang. Fake timers are scoped tightly to just the
    // debounce advance below (and limited to setTimeout/clearTimeout so
    // React's own scheduler, unrelated to our debounce, is untouched).
    const { getMock } = renderInboxWithFakeGet();
    const input = await screen.findByLabelText("Search conversations");
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(input, { target: { value: "jane" } });

      // Not yet debounced — no q= request fired on the leading edge of typing.
      expect(getMock).not.toHaveBeenCalledWith(expect.stringContaining("q="));

      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?q=jane"));
  });

  it("toggling the archived filter adds archived=true to the request", async () => {
    const { getMock } = renderInboxWithFakeGet();
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));

    await user.click(await screen.findByRole("button", { name: "Show archived conversations" }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?archived=true"));
  });

  it("composes the archived toggle with a non-default state tab (both params sent together)", async () => {
    const { getMock } = renderInboxWithFakeGet();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Closed" }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?state=closed"));

    await user.click(screen.getByRole("button", { name: "Show archived conversations" }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?state=closed&archived=true"));
  });

  it("InboxPage's own freshness query and ConversationList's rendered rows always resolve to ONE shared request per state/q/archived combination (identical query keys)", async () => {
    // Regression guard for the CRITICAL wiring constraint: if InboxPage and
    // ConversationList ever called useConversations with different q/archived
    // values, TanStack Query would issue TWO distinct conversations requests
    // for a single user action instead of sharing one cache entry/fetch.
    const { getMock } = renderInboxWithFakeGet();
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));
    const callCountBeforeToggle = getMock.mock.calls.filter((c) => c[0] === "/api/v1/conversations").length;

    await user.click(await screen.findByRole("button", { name: "Show archived conversations" }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?archived=true"));

    // Exactly one request for the "all conversations" key fired before the
    // toggle (deduped across InboxPage's and ConversationList's hook calls) —
    // proves the two call sites share a single cache entry rather than
    // fetching independently.
    expect(callCountBeforeToggle).toBe(1);
  });
});

function renderInboxWithFakeGet() {
  const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/messages")) return Promise.resolve({ items: [] });
    if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
    if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InboxPage />
    </QueryClientProvider>
  );
  return { getMock };
}

describe("InboxPage — message search result selection (Task 26)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("selecting a message search result whose conversation IS in the currently loaded list opens it directly", async () => {
    const searchResult = {
      id: "sm1",
      conversationId: "c-unread",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "urgent: please call back",
      contactName: "Has Unread"
    };
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Search conversations"), "urgent");
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    // Click the result's visible text (a descendant of the row's <button>), not the
    // <li role="option"> wrapper itself — the onClick handler lives on the <button>,
    // and a click on an ancestor element never bubbles DOWN into a descendant.
    await user.click(await screen.findByText("Has Unread"));

    // c-unread has unreadCount 3 in CONVERSATIONS — mark-read firing for it is the
    // observable proof InboxPage resolved the search result's conversationId against
    // the already-loaded list and made it `active`, without any extra id-lookup fetch.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-unread/read", {}), {
      timeout: 3000
    });
  });

  it("selecting a message search result NOT in the current (filtered) list resets filters and selects it once the broadened list contains it — the documented fallback for the missing GET /api/v1/conversations/:id endpoint", async () => {
    const hidden = conv({ id: "c-hidden", unreadCount: 1, contactName: "Hidden Contact", state: "closed" });
    const searchResult = {
      id: "sm1",
      conversationId: "c-hidden",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "a message only findable by content search",
      contactName: "Hidden Contact"
    };
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      // "closed" tab (filtered) view does NOT include the target conversation...
      if (path === "/api/v1/conversations?state=closed") return Promise.resolve({ items: CONVERSATIONS });
      // ...but the reset/default view (state=all, no q, not archived) does.
      if (path === "/api/v1/conversations") return Promise.resolve({ items: [...CONVERSATIONS, hidden] });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Closed" }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?state=closed"));

    const input = await screen.findByLabelText("Search conversations");
    await user.type(input, "hidden");
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    await user.click(await screen.findByText("Hidden Contact"));

    // Fallback fired: the search box was cleared as part of resetting filters.
    await waitFor(() => expect(input).toHaveValue(""), { timeout: 3000 });
    // Once the broadened default list lands with the target row, it's selected and
    // mark-read fires for it — proof the id -> Conversation resolution completed.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-hidden/read", {}), {
      timeout: 3000
    });
  });
});

describe("InboxPage — bounded archived-aware fallback for message search selection (review finding 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("escalates to the archived view (one bounded second attempt) and selects a search hit that only exists there", async () => {
    // The default (non-archived) list NEVER contains this conversation — only
    // the archived one does. Search hits carry no archived signal up front,
    // so InboxPage must try the default reset first, find nothing, then
    // escalate exactly once to archived=true before it can resolve this.
    const archivedConv = conv({ id: "c-archived", unreadCount: 1, contactName: "Archived Contact" });
    const searchResult = {
      id: "sm2",
      conversationId: "c-archived",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "a message whose conversation lives only in the archived folder",
      contactName: "Archived Contact"
    };
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path === "/api/v1/conversations") return Promise.resolve({ items: CONVERSATIONS });
      if (path === "/api/v1/conversations?archived=true") return Promise.resolve({ items: [archivedConv] });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));

    const input = await screen.findByLabelText("Search conversations");
    await user.type(input, "archived folder");
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    await user.click(await screen.findByText("Archived Contact"));

    // The bounded second attempt: escalated to the archived view.
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?archived=true"));
    await screen.findByRole("button", { name: "Show active conversations" });

    // Selection completed against the archived list — proven via mark-read firing.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-archived/read", {}), {
      timeout: 3000
    });
  });

  it("disarms the pending selection and surfaces feedback when the target is in neither the default nor archived view (no lingering scan)", async () => {
    const searchResult = {
      id: "sm3",
      conversationId: "c-ghost",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "a message pointing at a conversation that never resolves",
      contactName: "Ghost Contact"
    };
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      // Neither the default nor the archived view ever contains the target.
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const toastErrorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );
    const user = userEvent.setup();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));

    const input = await screen.findByLabelText("Search conversations");
    await user.type(input, "ghost");
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    await user.click(await screen.findByText("Ghost Contact"));

    // Escalated to archived (second bounded attempt)...
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?archived=true"));
    // ...which also settles empty, so the fallback disarms and tells the user.
    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(toastErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Couldn't open that conversation"));

    // Round-2 review finding 2: archived resets back to false alongside the
    // toast, so the user lands back where they started instead of being
    // parked in an archived view they never asked for.
    expect(await screen.findByRole("button", { name: "Show archived conversations" })).toBeInTheDocument();

    // No lingering scan: once pendingSelect is disarmed, a LATER data change
    // that would satisfy the old target id must NOT retroactively select it.
    // Injected under the now-active `{state:"all"}` key (archived having
    // just reset to false above) — not `{state:"all", archived:true}`,
    // which is no longer what's on screen.
    client.setQueryData(["conversations", { state: "all" }], {
      items: [{ ...CONVERSATIONS[0], id: "c-ghost", contactName: "Ghost Contact", unreadCount: 5 }]
    });

    // Wait for the injected row to actually land in the (now-visible, since
    // search was cleared by the fallback) conversation list — proof the
    // re-render with the new data happened — then assert it was never
    // auto-selected/mark-read despite now being resolvable by id.
    await waitFor(() => expect(screen.getByText("Ghost Contact")).toBeInTheDocument());
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("InboxPage — pendingSelect cancellation on competing user actions (review finding 1, round 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cancels a pending search-hit selection when the user clicks a different conversation before it resolves", async () => {
    // Reproduction from the reviewer: click an archived-only search hit
    // (arms pendingSelect, clears search) -> before the debounce+archived
    // fetch settle, click a DIFFERENT conversation in the visible list.
    // Without cancellation, the late-resolving fallback would flip
    // archived=true and select() the stale archived-only target out from
    // under the user's own choice, re-firing mark-read for a conversation
    // they never picked.
    const archivedConv = conv({ id: "c-archived", unreadCount: 1, contactName: "Archived Contact" });
    const searchResult = {
      id: "sm4",
      conversationId: "c-archived",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "a message whose conversation lives only in the archived folder",
      contactName: "Archived Contact"
    };
    // Mock POST to actually persist the read (mirrors the "closed tab" and
    // debounce-regression tests above) — otherwise a static GET mock
    // "bounces" unreadCount back up to 3 on useMarkRead's post-mutation
    // invalidate+refetch, re-firing the effect a SECOND, unrelated time and
    // producing a false-positive on the exactly-once assertion below.
    let items = CONVERSATIONS;
    const postMock = vi.spyOn(api, "post").mockImplementation((path: string) => {
      items = items.map((c) => (path.includes(c.id) ? { ...c, unreadCount: 0 } : c));
      return Promise.resolve({ status: "read", conversationId: "" });
    });
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path === "/api/v1/conversations?archived=true") return Promise.resolve({ items: [archivedConv] });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );

    // Settle the initial mount fetch on real timers first — faking globals
    // during React's initial mount/effect flush is what causes hangs (see
    // the debounce tests above).
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));
    const input = await screen.findByLabelText("Search conversations");
    const user = userEvent.setup();

    // Type the search and let the debounce land on real timers. This also
    // warms the cache for `{state:"all", q:"archived folder", archived:false}`
    // — ConversationList's OWN useConversations call runs unconditionally
    // regardless of which scope panel is showing — which is what lets the
    // conversation list render actual (not loading) rows the instant the
    // search-hit click below resets `rawQuery` back to "".
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(input, { target: { value: "archived folder" } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }

    // Radix's Tabs.Trigger needs a real pointer-event sequence to register a
    // value change — a raw `fireEvent.click` doesn't activate it.
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    const hit = await screen.findByText("Archived Contact");

    // Everything from here happens inside ONE fake-timer window so the
    // debounce timer the click below schedules is captured by the fake
    // clock — a setTimeout scheduled under real timers keeps running in
    // real time even after switching to fake timers afterward, so it has to
    // be scheduled AFTER faking is already active to stay controllable.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Arms pendingSelect (stage "default") and resets rawQuery/state/archived.
      fireEvent.click(hit);

      // The reset makes `isSearching` false immediately, so ConversationList
      // swaps back to the plain listbox — sourced from the SAME (already
      // warmed, settled) cache entry, so "Has Unread" is already in the DOM
      // synchronously here, no waiting required. Click it — a normal,
      // USER-originated row click — BEFORE the frozen debounce (or any
      // archived escalation) can run.
      fireEvent.click(screen.getByText("Has Unread"));

      // Now let the frozen debounce — and anything it would have triggered —
      // run all the way out. Without the fix, THIS is where the stale
      // fallback would flip archived=true and select() the archived-only
      // target.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    // The user's own selection wins.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c-unread/read", {}));
    // Archived is never flipped on by the (cancelled) fallback...
    expect(await screen.findByRole("button", { name: "Show archived conversations" })).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalledWith("/api/v1/conversations?archived=true");
    // ...and the stale target is never selected / mark-read.
    expect(postMock).not.toHaveBeenCalledWith("/api/v1/conversations/c-archived/read", {});
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending search-hit selection when the user switches the state tab before it resolves — no retroactive navigation once filters realign", async () => {
    // Mid-flight tab-switch variant of the interference test above: arming
    // pendingSelect and then switching the state tab must disarm it outright
    // (not just gate it behind state !== "all") — otherwise switching back
    // to "All" later, once the target legitimately becomes fetchable, would
    // resolve the stale fallback retroactively.
    const searchResult = {
      id: "sm5",
      conversationId: "c-tabswitch",
      direction: "inbound" as const,
      status: "delivered" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      text: "a message pointing at a conversation not yet loaded",
      contactName: "Tab Switch Contact"
    };
    let allItems = CONVERSATIONS;
    const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "read", conversationId: "" });
    const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.startsWith("/api/v1/messages/search")) {
        return Promise.resolve({ items: [searchResult], total: 1, limit: 20, offset: 0 });
      }
      if (path.includes("/messages")) return Promise.resolve({ items: [] });
      if (path === "/api/v1/saved-replies") return Promise.resolve({ items: [] });
      if (path === "/api/v1/conversations") return Promise.resolve({ items: allItems });
      if (path.startsWith("/api/v1/conversations")) return Promise.resolve({ items: CONVERSATIONS });
      return Promise.reject(new Error(`Unhandled GET ${path}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    );

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations"));
    const input = await screen.findByLabelText("Search conversations");
    const user = userEvent.setup();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(input, { target: { value: "tab switch" } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }

    // Radix's Tabs.Trigger needs a real pointer-event sequence to register a
    // value change — a raw `fireEvent.click` doesn't activate it, and
    // `userEvent` in turn needs REAL timers (its internal event sequencing
    // awaits a real `setTimeout` even at `delay: 0`, which would hang
    // against a frozen fake clock). So this whole interference window runs
    // on real timers instead of a frozen debounce: click the search hit
    // (arms pendingSelect) and click the "Open" tab (the competing
    // USER-originated action) back-to-back, with no `await` for anything
    // else in between — both resolve in low single-digit milliseconds in
    // practice, comfortably inside the 300ms debounce window this needs to
    // land within.
    await user.click(await screen.findByRole("tab", { name: "Messages" }));
    const hit = await screen.findByText("Tab Switch Contact");

    await user.click(hit); // arms pendingSelect (stage "default")
    await user.click(screen.getByRole("tab", { name: "Open" })); // competing user action

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/conversations?state=open"));

    // The target now legitimately exists in the "All" tab's data (e.g. a
    // background sync landed it) — the exact condition `stageFiltersSettled`
    // would have required. If pendingSelect had merely been GATED by
    // state !== "all" instead of genuinely disarmed, switching back to "All"
    // would resolve it retroactively.
    allItems = [...CONVERSATIONS, conv({ id: "c-tabswitch", unreadCount: 4, contactName: "Tab Switch Contact" })];

    await user.click(await screen.findByRole("tab", { name: "All" }));

    await waitFor(() => expect(screen.getByText("Tab Switch Contact")).toBeInTheDocument());
    expect(postMock).not.toHaveBeenCalled();
  });
});
