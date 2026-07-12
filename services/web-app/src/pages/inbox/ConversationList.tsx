import { Archive, Pin } from "lucide-react";
import type { Conversation } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { initials, timeAgo } from "@/lib/format";
import { useConversations, type ConvStateFilter } from "@/hooks/use-conversations";

interface Props {
  activeId?: string;
  onSelect: (c: Conversation) => void;
  /**
   * Tab/state filter is owned by the parent (InboxPage) rather than kept
   * locally here: InboxPage needs to read live rows for whatever tab is
   * currently displayed (to know when to re-fire mark-read on a fresh
   * inbound), and that's only correct if it queries the SAME
   * `["conversations", { state, q, archived }]` cache entry this list
   * renders from. A locally-owned `state`/`q`/`archived` here diverging from
   * what InboxPage passes to its own useConversations call would let the two
   * cache entries split apart whenever the user searches, filters archived,
   * or is on a non-default tab — see Task 22 review finding 1 (state) and
   * Task 24 (q/archived extend the same invariant).
   */
  state: ConvStateFilter;
  onStateChange: (state: ConvStateFilter) => void;
  /** Raw (un-debounced) search box value — controlled from InboxPage so typing stays responsive. */
  search: string;
  onSearchChange: (value: string) => void;
  /** Debounced search value actually sent to useConversations — MUST match InboxPage's own call. */
  q: string;
  archived: boolean;
  onArchivedChange: (archived: boolean) => void;
}

export function ConversationList({
  activeId,
  onSelect,
  state,
  onStateChange,
  search,
  onSearchChange,
  q,
  archived,
  onArchivedChange
}: Props) {
  // Server now does the filtering/sorting (search on contact name/phone,
  // archived-folder membership, pinned-first ordering) — no client-side
  // useMemo filter or sort needed; `items` is rendered straight off the page.
  const { data, isLoading } = useConversations(state, q, archived);
  const items = data?.items ?? [];

  return (
    <div className="flex h-full w-full flex-col border-r border-border md:w-80">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search conversations"
          />
          <Button
            type="button"
            variant={archived ? "secondary" : "ghost"}
            size="icon"
            aria-pressed={archived}
            aria-label={archived ? "Show active conversations" : "Show archived conversations"}
            title={archived ? "Showing archived" : "Show archived"}
            onClick={() => onArchivedChange(!archived)}
          >
            <Archive className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <Tabs value={state} onValueChange={(v) => onStateChange(v as ConvStateFilter)}>
          <TabsList className="w-full">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="closed">Closed</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Conversations">
        {isLoading ? (
          <li className="space-y-3 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </li>
        ) : items.length === 0 ? (
          <li className="p-6 text-center text-sm text-muted-foreground">No conversations</li>
        ) : (
          items.map((c) => {
            const unread = c.unreadCount > 0;
            return (
              <li key={c.id} role="option" aria-selected={c.id === activeId}>
                <button
                  onClick={() => onSelect(c)}
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-accent",
                    c.id === activeId && "bg-accent"
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                    {initials(c.contactName, c.contactPhone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1">
                        {c.pinnedAt ? (
                          <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
                        ) : null}
                        <span className="truncate text-sm font-medium">
                          {c.contactName || c.contactPhone || "Unknown"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-muted-foreground">{c.lastMessage || "—"}</span>
                      {unread ? (
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {/* Decorative — the count badge below carries the one accessible name for this indicator. */}
                          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                          <Badge
                            variant="gray"
                            className="h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                            aria-label={`${c.unreadCount} unread messages`}
                          >
                            {c.unreadCount}
                          </Badge>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
