import { useEffect, useState } from "react";
import type { Conversation } from "@hyfib/shared-core";
import { toast } from "sonner";
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
  // selectConversationById below. `stage` is a bounded two-step ladder:
  //  - "default": filters were just reset to state=all/q=""/archived=false
  //    and we're waiting for THAT list to settle (search hits carry no
  //    archived signal, so the non-archived view is tried first).
  //  - "archived": the "default" view settled without the target, so we
  //    escalate exactly once more by flipping archived=true.
  // If "archived" also settles without a match, the render-body resolver
  // below disarms this (back to undefined) and surfaces feedback instead of
  // leaving it armed to silently re-scan every future render (review
  // finding 1, Task 26 re-review).
  const [pendingSelect, setPendingSelect] = useState<{ id: string; stage: "default" | "archived" } | undefined>();
  const { data, isFetching, isPlaceholderData } = useConversations(state, query, archived);

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
  // the selection once that row appears (see the render-body resolver
  // below, which also escalates to the archived view and bounds the
  // fallback with feedback — review finding 1, Task 26 re-review).
  function selectConversationById(conversationId: string) {
    const found = data?.items.find((c) => c.id === conversationId);
    if (found) {
      select(found);
      return;
    }
    setPendingSelect({ id: conversationId, stage: "default" });
    setState("all");
    setArchived(false);
    setRawQuery("");
  }

  // Resolves (or bounds) a pending fallback selection once `data` has
  // actually SETTLED for the CURRENT query key — not while a fetch for that
  // key is still in flight or still showing `keepPreviousData`'s placeholder
  // from the OLD key. Judging "not found" against a stale/in-flight `data`
  // would disarm or escalate prematurely, before the broadened/archived list
  // it's supposed to check has actually landed.
  //
  // Deliberately done HERE, directly in the render body, rather than in a
  // useEffect: `data`/`isFetching`/`isPlaceholderData` changing is itself
  // what re-renders this component (TanStack Query owns that), so this is
  // "adjusting state when a dependency changes" — React's documented
  // alternative to an effect for this exact shape (and, unlike an effect,
  // it never commits/flashes the stale "not yet selected" frame first).
  //
  // Why this can't loop: `stage` only ever advances through a strictly
  // bounded ladder — "default" -> "archived" -> disarmed (undefined) — and
  // every branch below either finishes (select + clear `pendingSelect`) or
  // advances the stage while flipping `archived`, which is the only thing
  // that can make `settled` false again on the next render. No branch ever
  // re-arms "default" or retries "archived" for the same id, so at most two
  // resolve passes run before this is guaranteed to disarm.
  // `settled` alone isn't enough: right after selectConversationById resets
  // state/archived/rawQuery, `query` (the DEBOUNCED search value) still lags
  // behind rawQuery for up to the debounce window, so `data` can transiently
  // reflect a stale, only-partially-reset key (e.g. state="all" but q is
  // still the old search text) that TanStack Query has already fully
  // fetched/settled for. Judging "not found" against THAT key — instead of
  // the fully-reset one this stage is actually meant to check — is exactly
  // what caused a premature escalation/disarm in practice. `stageFiltersSettled`
  // requires state/archived/query to all match what this stage reset them to
  // before trusting `data`'s found/not-found verdict.
  const settled = !isFetching && !isPlaceholderData;
  const stageFiltersSettled =
    pendingSelect !== undefined &&
    state === "all" &&
    query.trim().length === 0 &&
    archived === (pendingSelect.stage === "archived");
  if (pendingSelect && data && settled && stageFiltersSettled) {
    const found = data.items.find((c) => c.id === pendingSelect.id);
    if (found) {
      select(found);
      setPendingSelect(undefined);
    } else if (pendingSelect.stage === "default") {
      // Search hits carry no archived signal up front — the target may
      // simply live in the archived folder. One bounded second attempt
      // before giving up.
      setPendingSelect({ id: pendingSelect.id, stage: "archived" });
      setArchived(true);
    } else {
      // Both the default and archived views settled without the target —
      // it's genuinely unreachable (deleted, wrong tenant, etc). Disarm so
      // this stops re-scanning every future render, and tell the user
      // instead of silently no-op'ing. Also reset `archived` back to false
      // (round-2 review finding 2) so the user lands where they started —
      // the toast already explains the failure; an unexplained archived
      // view on top of that is just confusing.
      setPendingSelect(undefined);
      setArchived(false);
      toast.error("Couldn't open that conversation — it may no longer be available.");
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
    // Round-2 review finding 1: any USER-originated selection — including a
    // normal row click while a search-hit fallback is still armed — must
    // cancel that fallback outright, not just get raced by it. Without this,
    // clicking a different conversation while `pendingSelect` is resolving
    // (e.g. still waiting on the debounce+archived-escalation ladder above)
    // doesn't stop that ladder from later finding its stale target and
    // calling `select()` on it out from under the user's own choice — re-
    // firing mark-read for a conversation they never picked. Safe to call
    // unconditionally here even for the resolver's OWN internal `select(found)`
    // call above: that call is immediately followed by an explicit
    // `setPendingSelect(undefined)` anyway, so this is a harmless no-op in
    // that path and the real effect only lands on the user-click path.
    setPendingSelect(undefined);
    setActive(c);
  }

  // Wrap the state/archived/search setters passed to ConversationList so a
  // USER-originated tab switch, archived toggle, or search-box retype also
  // disarms an in-flight `pendingSelect` fallback (round-2 review finding 1;
  // search retype added round-3 review finding 2) — mirroring `select` above
  // for the other ways the user can compete with it. Deliberately NOT used
  // by the resolver's own internal `setArchived(true)` escalation call
  // above, nor by `selectConversationById`'s own filter reset (including its
  // own `setRawQuery("")`) when arming `pendingSelect` in the first place —
  // both of those are the fallback's OWN bookkeeping, not a competing user
  // action, and must not cancel the very selection they're driving.
  function handleUserStateChange(next: ConvStateFilter) {
    setPendingSelect(undefined);
    setState(next);
  }

  function handleUserArchivedChange(next: boolean) {
    setPendingSelect(undefined);
    setArchived(next);
  }

  function handleUserSearchChange(value: string) {
    setPendingSelect(undefined);
    setRawQuery(value);
  }

  return (
    <div className="flex h-full">
      {/* Mobile: show list OR chat; desktop: both side by side. */}
      <div className={cn("h-full w-full md:block md:w-auto", active && "hidden md:block")}>
        <ConversationList
          activeId={active?.id}
          onSelect={select}
          state={state}
          onStateChange={handleUserStateChange}
          search={rawQuery}
          onSearchChange={handleUserSearchChange}
          q={query}
          archived={archived}
          onArchivedChange={handleUserArchivedChange}
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
