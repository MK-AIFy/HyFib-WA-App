import { useEffect, useState } from "react";
import type { Conversation } from "@hyfib/shared-core";
import { cn } from "@/lib/utils";
import { useConversations, useMarkRead, type ConvStateFilter } from "@/hooks/use-conversations";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ConversationList, type SearchScope } from "./ConversationList";
import { ChatPane } from "./ChatPane";

const SEARCH_DEBOUNCE_MS = 300;

export function InboxPage() {
  const [active, setActive] = useState<Conversation | undefined>();
  const markRead = useMarkRead();
  // The tab/state filter is owned HERE (not inside ConversationList) and
  // passed down as a controlled prop. That guarantees this page's freshness
  // query below uses the exact same `["conversations", { state }]` cache key
  // ConversationList renders its rows from — so whichever row the user
  // actually clicked (even from a filtered tab like "closed") is guaranteed
  // to be present in `data`, and TanStack Query dedupes the two useConversations
  // calls into a single shared cache entry / fetch. A previous version of
  // this page always queried the "all" tab regardless of which tab the list
  // was showing, so a conversation selected from e.g. "closed" could be
  // absent from `data` (top-25 unfiltered page) and `freshActive` would stay
  // undefined forever — silently breaking the mark-read re-fire on a new
  // inbound for that conversation (see Task 22 review finding 1).
  const [state, setState] = useState<ConvStateFilter>("all");
  // Task 24 extends the same lifted-state invariant to `q`/`archived`: both
  // must reach this page's own useConversations call AND ConversationList's,
  // with identical values, or the two diverge into separate cache entries
  // and freshActive lookups below go stale again for the same reason
  // documented above. `rawQuery` is what the <Input> is bound to (so typing
  // stays responsive); `query` is the debounced value actually sent to the
  // hook/server, and it's what's passed to ConversationList as `q` — NOT
  // `rawQuery` — so both useConversations calls fetch/key off the same
  // debounced string instead of ConversationList re-fetching on every
  // keystroke while this page fetches on a lagging value.
  const [rawQuery, setRawQuery] = useState("");
  const query = useDebouncedValue(rawQuery, SEARCH_DEBOUNCE_MS);
  const [archived, setArchived] = useState(false);
  // Task 26: "Conversations" vs "Messages" search scope, same lifted-state
  // pattern as state/q/archived above — see ConversationList's SearchScope.
  const [scope, setScope] = useState<SearchScope>("conversations");
  // Set only while resolving a message-search result whose conversation
  // wasn't present in the currently loaded (possibly filtered) list — see
  // selectConversationById below.
  const [pendingSelectId, setPendingSelectId] = useState<string | undefined>();
  const { data } = useConversations(state, query, archived);

  const freshActive = active ? data?.items.find((c) => c.id === active.id) : undefined;
  const selectedId = active?.id;
  const selectedUnreadCount = freshActive?.unreadCount ?? active?.unreadCount ?? 0;
  // Residual edge (Task 24 re-review): searching/filtering the actively-open conversation OUT of
  // the result set can still re-fire markRead once after the new fetch settles (freshActive
  // undefined -> stale snapshot fallback). Accepted: duplicate POST is idempotent server-side (watermark).

  // A message-search result (from Task 26) only carries a conversationId, so
  // resolve it against the SAME `data` this page already reads freshness
  // from. There is no `GET /api/v1/conversations/:id` endpoint (checked
  // api-gateway/src/index.ts — only list/action routes under
  // /api/v1/conversations exist), so when the target isn't in the current
  // (possibly filtered) page, the smallest correct fallback is resetting the
  // filters to their defaults so the list broadens/refetches, then finishing
  // the selection once that row appears (see the render-body check below).
  // Known residual gap: if the target conversation is itself archived,
  // resetting `archived` to false won't surface it — left for a future
  // single-conversation fetch.
  function selectConversationById(conversationId: string) {
    const found = data?.items.find((c) => c.id === conversationId);
    if (found) {
      select(found);
      return;
    }
    setPendingSelectId(conversationId);
    setState("all");
    setArchived(false);
    setRawQuery("");
  }

  // Resolves a pending fallback selection the moment `data` (already updated
  // by the filter reset above) contains the target row. Deliberately done
  // HERE, directly in the render body, rather than in a useEffect: `data`
  // changing is itself what re-renders this component (TanStack Query owns
  // that), so this is "adjusting state when a dependency changes" — React's
  // documented alternative to an effect for this exact shape. It's
  // self-limiting (setPendingSelectId(undefined) below makes the condition
  // false on the very next render), so it converges in one extra render
  // pass, never loops, and — unlike an effect — never commits/flashes the
  // stale "not yet selected" frame to the screen first.
  if (pendingSelectId && data) {
    const found = data.items.find((c) => c.id === pendingSelectId);
    if (found) {
      select(found);
      setPendingSelectId(undefined);
    }
  }

  useEffect(() => {
    if (selectedId && selectedUnreadCount > 0) {
      markRead.mutate(selectedId);
    }
    // Deliberately depends only on [selectedId, selectedUnreadCount], not on
    // markRead.mutate: those two values are the actual signal ("a
    // conversation with unread messages is open"), so the mutation fires
    // exactly once per genuinely-new unread state instead of once per
    // unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedUnreadCount]);

  function select(c: Conversation) {
    setActive(c);
  }

  return (
    <div className="flex h-full">
      {/* Mobile: show list OR chat; desktop: both side by side. */}
      <div className={cn("h-full w-full md:block md:w-auto", active && "hidden md:block")}>
        <ConversationList
          activeId={active?.id}
          onSelect={select}
          state={state}
          onStateChange={setState}
          search={rawQuery}
          onSearchChange={setRawQuery}
          q={query}
          archived={archived}
          onArchivedChange={setArchived}
          scope={scope}
          onScopeChange={setScope}
          onSelectConversation={selectConversationById}
        />
      </div>
      <div className={cn("h-full flex-1", !active && "hidden md:flex")}>
        {active ? (
          // Same fresh-row source as the mark-read effect above, so the
          // header (state badge, etc.) never renders a stale snapshot either.
          <ChatPane conversation={freshActive ?? active} onBack={() => setActive(undefined)} />
        ) : (
          <div className="hidden h-full flex-1 items-center justify-center text-sm text-muted-foreground md:flex">
            Select a conversation to start
          </div>
        )}
      </div>
    </div>
  );
}
