import { useEffect, useState } from "react";
import type { Conversation } from "@hyfib/shared-core";
import { cn } from "@/lib/utils";
import { ConversationList } from "./ConversationList";
import { ChatPane } from "./ChatPane";
import { markRead } from "./unread";

export function InboxPage() {
  const [active, setActive] = useState<Conversation | undefined>();

  useEffect(() => {
    if (active) markRead(active.id);
  }, [active]);

  function select(c: Conversation) {
    setActive(c);
    markRead(c.id);
  }

  return (
    <div className="flex h-full">
      {/* Mobile: show list OR chat; desktop: both side by side. */}
      <div className={cn("h-full w-full md:block md:w-auto", active && "hidden md:block")}>
        <ConversationList activeId={active?.id} onSelect={select} />
      </div>
      <div className={cn("h-full flex-1", !active && "hidden md:flex")}>
        {active ? (
          <ChatPane conversation={active} onBack={() => setActive(undefined)} />
        ) : (
          <div className="hidden h-full flex-1 items-center justify-center text-sm text-muted-foreground md:flex">
            Select a conversation to start
          </div>
        )}
      </div>
    </div>
  );
}
