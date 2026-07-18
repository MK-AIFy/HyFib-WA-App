import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Advisory bar shown above the composer when the 24h customer-service window is
 * closed. Non-blocking: the composer stays enabled (the server accepts the send,
 * it just may fail), but this steers the agent toward a template instead.
 */
export function SessionWindowBanner({ onSendTemplate }: { onSendTemplate: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 border-t border-border bg-warn/10 px-3 py-2 text-xs">
      <Clock className="size-4 shrink-0 text-warn" aria-hidden="true" />
      <span className="flex-1">
        Customer-service window closed — freeform messages may fail. Send a template instead.
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onSendTemplate}>
        Send template
      </Button>
    </div>
  );
}
