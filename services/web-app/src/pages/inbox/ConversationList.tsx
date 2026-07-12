import { useMemo, useState } from "react";
import type { Conversation } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { initials, timeAgo } from "@/lib/format";
import { useConversations, type ConvStateFilter } from "@/hooks/use-conversations";

interface Props {
  activeId?: string;
  onSelect: (c: Conversation) => void;
}

export function ConversationList({ activeId, onSelect }: Props) {
  const [state, setState] = useState<ConvStateFilter>("all");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useConversations(state);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    // Client-side filter over the loaded page; server-side search is a
    // flagged backend follow-up (see plan "Out of scope").
    return all.filter((c) =>
      [c.contactName, c.contactPhone, c.lastMessage].some((f) => f?.toLowerCase().includes(q))
    );
  }, [data, search]);

  return (
    <div className="flex h-full w-full flex-col border-r border-border md:w-80">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <Input
          placeholder="Search loaded conversations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search conversations"
        />
        <Tabs value={state} onValueChange={(v) => setState(v as ConvStateFilter)}>
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
                      <span className="truncate text-sm font-medium">
                        {c.contactName || c.contactPhone || "Unknown"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-muted-foreground">{c.lastMessage || "—"}</span>
                      {unread ? (
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          <span className="size-2 rounded-full bg-primary" aria-label="Unread" />
                          <Badge variant="gray" className="h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none">
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
