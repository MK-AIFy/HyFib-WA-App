import { useState } from "react";
import type { Template } from "@hyfib/shared-core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { placeholderCount, substituteTemplate } from "@/lib/message-kind";
import { useSendMessage } from "@/hooks/use-conversations";
import { useList } from "@/hooks/use-resource";
import { toTemplateBody } from "./schemas";
import { sendErrorMessage } from "./send-error";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sends an approved WhatsApp template into the conversation. Lists approved
 * templates (server-side filtered), reveals one input per positional `{{n}}`
 * placeholder in the chosen template body, and shows a live substituted
 * preview. Reused by the attach menu and the 24h-window banner.
 */
export function TemplatePickerDialog({ conversationId, open, onOpenChange }: Props) {
  const { data, isLoading } = useList<Template>(["templates", "approved"], "/api/v1/templates?status=approved");
  const templates = (data?.items ?? []).filter((t) => t.status === "approved");
  const send = useSendMessage(conversationId);
  const [selectedId, setSelectedId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);

  const selected = templates.find((t) => t.id === selectedId);

  function reset() {
    setSelectedId("");
    setParams([]);
    setShowErrors(false);
  }

  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function pick(id: string) {
    setSelectedId(id);
    setShowErrors(false);
    const t = templates.find((x) => x.id === id);
    setParams(t ? Array(placeholderCount(t.body)).fill("") : []);
  }

  function setParam(index: number, value: string) {
    setParams((prev) => prev.map((p, i) => (i === index ? value : p)));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (params.some((p) => p.trim() === "")) {
      setShowErrors(true);
      return;
    }
    send.mutate(toTemplateBody(selected.name, selected.language, params), {
      onSuccess: () => {
        toast.success("Template sent");
        reset();
        onOpenChange(false);
      },
      onError: (err) => toast.error(sendErrorMessage(err))
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading templates…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No approved templates. Sync approved templates from Meta on the Templates page first.
          </p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-select">Template</Label>
              <Select value={selectedId} onValueChange={pick}>
                <SelectTrigger id="tpl-select" aria-label="Template">
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selected ? (
              <>
                <div className="rounded-md border border-border bg-background/50 px-3 py-2 text-sm">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Preview</p>
                  <p className="whitespace-pre-wrap break-words">{substituteTemplate(selected.body, params)}</p>
                </div>
                {params.map((value, i) => {
                  const missing = showErrors && value.trim() === "";
                  return (
                    <div key={i} className="flex flex-col gap-1.5">
                      <Label htmlFor={`tpl-param-${i}`}>{`{{${i + 1}}}`}</Label>
                      <Input
                        id={`tpl-param-${i}`}
                        value={value}
                        aria-invalid={missing}
                        onChange={(e) => setParam(i, e.target.value)}
                      />
                      {missing ? <p className="text-xs text-destructive">Required</p> : null}
                    </div>
                  );
                })}
              </>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={!selected || send.isPending}>
                {send.isPending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
