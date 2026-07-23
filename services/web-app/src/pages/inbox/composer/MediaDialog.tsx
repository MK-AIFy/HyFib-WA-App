import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MEDIA_MAX_BYTES, useSendMedia, whatsAppMediaType } from "@/hooks/use-send-media";
import { formatBytes } from "@/lib/format";
import { Field } from "./Field";
import { mediaSendErrorMessage } from "./send-error";

interface Props {
  conversationId: string;
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sends a photo, video, audio clip or document. No react-hook-form here — a
 * File input plus one optional caption doesn't warrant a schema; the two
 * validations (file chosen, under the gateway's 16 MB cap) are inlined. The
 * caption field disappears for audio because WhatsApp has no audio captions
 * (useSendMedia would drop it anyway — hiding the field keeps the UI honest).
 */
export function MediaDialog({ conversationId, channelId, open, onOpenChange }: Props) {
  const send = useSendMedia(conversationId, channelId);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);

  function change(next: boolean) {
    if (!next) {
      setFile(null);
      setCaption("");
      setError(null);
    }
    onOpenChange(next);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (send.isPending) return;
    if (!file) {
      setError("Choose a file to send");
      return;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      setError("File is larger than 16 MB");
      return;
    }
    setError(null);
    send.mutate(
      { file, caption },
      {
        onSuccess: () => {
          toast.success("Attachment sent");
          change(false);
        },
        onError: (err) => toast.error(mediaSendErrorMessage(err))
      }
    );
  }

  const isAudio = file !== null && whatsAppMediaType(file.type) === "audio";

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a photo or file</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
          <Field label="File" id="media-file" error={error ?? undefined}>
            <Input
              id="media-file"
              type="file"
              aria-invalid={!!error}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setError(null);
              }}
            />
          </Field>
          {file ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{file.name}</span> · {formatBytes(file.size)}
            </p>
          ) : null}
          {isAudio ? null : (
            <Field label="Caption (optional)" id="media-caption">
              <Input id="media-caption" maxLength={1024} value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
          )}
          <DialogFooter>
            <Button type="submit" disabled={send.isPending}>
              {send.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
