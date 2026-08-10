import { useRef, useState, type KeyboardEvent } from "react";
import { MessageSquarePlus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useSavedReplies, useSendMessage } from "@/hooks/use-conversations";
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { AttachMenu } from "./composer/AttachMenu";
import { sendErrorMessage } from "./composer/send-error";

export function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage(conversationId);
  const signalTyping = useTypingIndicator(conversationId);
  const { data: saved } = useSavedReplies();

  function submit() {
    const value = text.trim();
    if (!value || send.isPending) return;
    send.mutate(
      { kind: "text", text: value },
      { onSuccess: () => setText(""), onError: (e) => toast.error(sendErrorMessage(e)) }
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-border p-3">
      <AttachMenu conversationId={conversationId} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Saved replies">
            <MessageSquarePlus className="size-5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-72">
          <DropdownMenuLabel>Saved replies</DropdownMenuLabel>
          {(saved?.items ?? []).length === 0 ? (
            <DropdownMenuItem disabled>None yet</DropdownMenuItem>
          ) : (
            saved!.items.map((r) => (
              <DropdownMenuItem
                key={r.id}
                onSelect={() => {
                  setText((t) => (t ? `${t} ${r.body}` : r.body));
                  ref.current?.focus();
                }}
              >
                <span className="truncate">{r.title}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          signalTyping();
        }}
        onKeyDown={onKeyDown}
        placeholder="Type a reply… (Enter to send, Shift+Enter for newline)"
        className="max-h-28 min-h-10 flex-1 resize-none"
        aria-label="Message"
      />
      <Button onClick={submit} disabled={!text.trim() || send.isPending} size="icon" aria-label="Send message">
        <Send className="size-5" aria-hidden="true" />
      </Button>
    </div>
  );
}
