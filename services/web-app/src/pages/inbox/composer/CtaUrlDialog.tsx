import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSendMessage } from "@/hooks/use-conversations";
import { Field } from "./Field";
import { ctaUrlSchema, toCtaUrlBody, type CtaUrlValues } from "./schemas";
import { sendErrorMessage } from "./send-error";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Sends a WhatsApp interactive "call-to-action URL" button message. */
export function CtaUrlDialog({ conversationId, open, onOpenChange }: Props) {
  const send = useSendMessage(conversationId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<CtaUrlValues>({ resolver: zodResolver(ctaUrlSchema) });

  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function onSubmit(values: CtaUrlValues) {
    send.mutate(toCtaUrlBody(values), {
      onSuccess: () => {
        toast.success("Button message sent");
        reset();
        onOpenChange(false);
      },
      onError: (e) => toast.error(sendErrorMessage(e))
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a link button</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
          <Field label="Message body" id="cta-body" error={errors.bodyText?.message}>
            <Textarea id="cta-body" aria-invalid={!!errors.bodyText} {...register("bodyText")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Header (optional)" id="cta-header" error={errors.headerText?.message}>
              <Input id="cta-header" aria-invalid={!!errors.headerText} {...register("headerText")} />
            </Field>
            <Field label="Footer (optional)" id="cta-footer" error={errors.footerText?.message}>
              <Input id="cta-footer" aria-invalid={!!errors.footerText} {...register("footerText")} />
            </Field>
          </div>
          <Field label="Button label" id="cta-label" error={errors.ctaDisplayText?.message}>
            <Input id="cta-label" aria-invalid={!!errors.ctaDisplayText} {...register("ctaDisplayText")} />
          </Field>
          <Field label="URL" id="cta-url" error={errors.ctaUrl?.message}>
            <Input
              id="cta-url"
              placeholder="https://example.com/…"
              aria-invalid={!!errors.ctaUrl}
              {...register("ctaUrl")}
            />
          </Field>
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
