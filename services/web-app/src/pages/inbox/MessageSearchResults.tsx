import type { ReactNode } from "react";
import type { MessageSearchResult } from "@hyfib/shared-core";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { useMessageSearch } from "@/hooks/use-message-search";

interface Props {
  /** Debounced search value — MUST match the `q` ConversationList/InboxPage use for conversation search. */
  q: string;
  /**
   * Resolves and opens the result's conversation. Message search results
   * only carry a `conversationId`, not a full `Conversation`, so this is a
   * plain id callback (unlike ConversationList's `onSelect`, which already
   * has the full row in hand) — InboxPage owns the id → Conversation
   * resolution (see its `selectConversationById`).
   */
  onSelectConversation: (conversationId: string) => void;
}

/**
 * Highlights the first case-insensitive occurrence of `query` inside
 * `text`. Deliberately uses plain `String#indexOf`, never
 * `new RegExp(query)` — `query` is arbitrary user input and may contain
 * regex metacharacters (`(`, `.`, `*`, `+`, ...) that would otherwise throw
 * or match in unintended ways.
 */
function highlightMatch(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const idx = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-warn/30 text-inherit">{text.slice(idx, idx + trimmed.length)}</mark>
      {text.slice(idx + trimmed.length)}
    </>
  );
}

function resultLabel(r: MessageSearchResult): string {
  return r.contactName || r.contactPhone || "Unknown";
}

export function MessageSearchResults({ q, onSelectConversation }: Props) {
  const trimmedQ = q.trim();
  const { data, isLoading } = useMessageSearch(q);
  const items = data?.items ?? [];

  return (
    <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Message search results">
      {trimmedQ.length < 2 ? (
        <li className="p-6 text-center text-sm text-muted-foreground">Type at least 2 characters to search messages</li>
      ) : isLoading ? (
        <li className="space-y-3 p-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </li>
      ) : items.length === 0 ? (
        <li className="p-6 text-center text-sm text-muted-foreground">No messages found</li>
      ) : (
        items.map((m) => (
          <li key={m.id} role="option">
            <button
              // Opens the conversation only. Scrolling ChatPane to this
              // specific message (deep-linking) is out of scope for v1.
              onClick={() => onSelectConversation(m.conversationId)}
              className="flex w-full flex-col gap-0.5 border-b border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-accent"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{resultLabel(m)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(m.createdAt)}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {m.direction === "outbound" ? "You: " : ""}
                {highlightMatch(m.text, q)}
              </span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}
