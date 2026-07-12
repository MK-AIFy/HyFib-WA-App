import { useEffect, useRef } from "react";
import { Archive, ArrowLeft, Pin } from "lucide-react";
import type { Conversation } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { mediaAssetOf } from "@/lib/media";
import {
  messageText,
  useArchiveConversation,
  useMessages,
  usePinConversation,
  useSetConversationState
} from "@/hooks/use-conversations";
import { Composer } from "./Composer";
import { MediaAttachment } from "./MediaAttachment";

const STATE_BADGE = { open: "green", pending: "yellow", closed: "gray" } as const;

export function ChatPane({ conversation, onBack }: { conversation: Conversation; onBack?: () => void }) {
  const { data, isLoading } = useMessages(conversation.id);
  const setState = useSetConversationState(conversation.id);
  const pinConversation = usePinConversation();
  const archiveConversation = useArchiveConversation();
  const endRef = useRef<HTMLDivElement>(null);
  const messages = data?.items ?? [];
  const isPinned = Boolean(conversation.pinnedAt);
  const isArchived = Boolean(conversation.archivedAt);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border p-3">
        {onBack ? (
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back to conversations">
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{conversation.contactName || conversation.contactPhone}</p>
          <p className="truncate text-xs text-muted-foreground">{conversation.contactPhone}</p>
        </div>
        <Badge variant={STATE_BADGE[conversation.state]}>{conversation.state}</Badge>
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={isPinned}
          aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
          title={isPinned ? "Unpin conversation" : "Pin conversation"}
          onClick={() => pinConversation.mutate({ id: conversation.id, pinned: !isPinned })}
        >
          <Pin className={cn("size-4", isPinned && "fill-current")} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={isArchived}
          aria-label={isArchived ? "Unarchive conversation" : "Archive conversation"}
          title={isArchived ? "Unarchive conversation" : "Archive conversation"}
          onClick={() => archiveConversation.mutate({ id: conversation.id, archived: !isArchived })}
        >
          <Archive className="size-4" aria-hidden="true" />
        </Button>
        <Select
          value={conversation.state}
          onValueChange={(v) => setState.mutate(v as "open" | "pending" | "closed")}
        >
          <SelectTrigger className="w-32" aria-label="Conversation state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 overflow-y-auto p-4" role="log" aria-live="polite" aria-label="Messages">
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">No messages yet</p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => {
              const media = mediaAssetOf(m);
              return (
                <div
                  key={m.id}
                  className={cn(
                    "max-w-[75%] rounded-lg px-3 py-2 text-sm",
                    m.direction === "outbound"
                      ? "self-end bg-primary/15 text-foreground"
                      : "self-start bg-secondary"
                  )}
                >
                  {media ? <MediaAttachment media={media} /> : null}
                  <p className="whitespace-pre-wrap break-words">{messageText(m)}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {timeAgo(m.createdAt)}
                    {m.direction === "outbound" ? ` · ${m.status}` : ""}
                  </p>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <Composer conversationId={conversation.id} />
    </div>
  );
}
