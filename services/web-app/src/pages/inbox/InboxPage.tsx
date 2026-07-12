import { useEffect, useState } from "react";
import type { Conversation } from "@hyfib/shared-core";
import { cn } from "@/lib/utils";
import { useConversations, useMarkRead } from "@/hooks/use-conversations";
import { ConversationList } from "./ConversationList";
import { ChatPane } from "./ChatPane";

export function InboxPage() {
  const [active, setActive] = useState<Conversation | undefined>();
  const markRead = useMarkRead();
  // "all" is a superset of every ConversationList tab filter, so the active
  // conversation's row is always present here — this is how the mark-read
  // effect below sees a fresh unreadCount after an SSE-driven refetch (e.g. a
  // new inbound landing on the conversation currently open), rather than the
  // snapshot captured once at click time in `active`.
  const { data } = useConversations("all");

  const freshActive = active ? data?.items.find((c) => c.id === active.id) : undefined;
  const selectedId = active?.id;
  const selectedUnreadCount = freshActive?.unreadCount ?? active?.unreadCount ?? 0;

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
        <ConversationList activeId={active?.id} onSelect={select} />
      </div>
      <div className={cn("h-full flex-1", !active && "hidden md:flex")}>
        {active ? (
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
