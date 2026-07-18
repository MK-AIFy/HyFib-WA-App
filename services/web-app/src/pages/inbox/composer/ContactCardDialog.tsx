import type { ReactNode } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSendMessage } from "@/hooks/use-conversations";
import { Field } from "./Field";
import { contactCardSchema, toContactsBody, type ContactCardValues } from "./schemas";
import { sendErrorMessage } from "./send-error";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULTS: ContactCardValues = {
  formattedName: "",
  firstName: "",
  lastName: "",
  phones: [{ phone: "", type: "" }],
  emails: []
};

/** Sends a single WhatsApp contact card with name and add/remove phone & email rows. */
export function ContactCardDialog({ conversationId, open, onOpenChange }: Props) {
  const send = useSendMessage(conversationId);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors }
  } = useForm<ContactCardValues>({ resolver: zodResolver(contactCardSchema), defaultValues: DEFAULTS });
  const phones = useFieldArray({ control, name: "phones" });
  const emails = useFieldArray({ control, name: "emails" });

  function change(next: boolean) {
    if (!next) reset(DEFAULTS);
    onOpenChange(next);
  }

  function onSubmit(values: ContactCardValues) {
    send.mutate(toContactsBody(values), {
      onSuccess: () => {
        toast.success("Contact sent");
        reset(DEFAULTS);
        onOpenChange(false);
      },
      onError: (e) => toast.error(sendErrorMessage(e))
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a contact card</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
          <Field label="Display name" id="cc-name" error={errors.formattedName?.message}>
            <Input id="cc-name" aria-invalid={!!errors.formattedName} {...register("formattedName")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name (optional)" id="cc-first" error={errors.firstName?.message}>
              <Input id="cc-first" {...register("firstName")} />
            </Field>
            <Field label="Last name (optional)" id="cc-last" error={errors.lastName?.message}>
              <Input id="cc-last" {...register("lastName")} />
            </Field>
          </div>

          <RowGroup
            title="Phones"
            addLabel="Add phone"
            onAdd={() => phones.append({ phone: "", type: "" })}
            addDisabled={phones.fields.length >= 10}
          >
            {phones.fields.map((field, i) => {
              const err = errors.phones?.[i]?.phone?.message;
              return (
                <div key={field.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Input
                      aria-label={`Phone ${i + 1}`}
                      placeholder="+15551234567"
                      aria-invalid={!!err}
                      {...register(`phones.${i}.phone`)}
                    />
                    {err ? <p className="mt-1 text-xs text-destructive">{err}</p> : null}
                  </div>
                  <Input
                    className="w-24"
                    aria-label={`Phone ${i + 1} type`}
                    placeholder="CELL"
                    {...register(`phones.${i}.type`)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove phone ${i + 1}`}
                    onClick={() => phones.remove(i)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              );
            })}
          </RowGroup>

          <RowGroup
            title="Emails"
            addLabel="Add email"
            onAdd={() => emails.append({ email: "", type: "" })}
            addDisabled={emails.fields.length >= 10}
          >
            {emails.fields.map((field, i) => {
              const err = errors.emails?.[i]?.email?.message;
              return (
                <div key={field.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Input
                      aria-label={`Email ${i + 1}`}
                      placeholder="name@example.com"
                      aria-invalid={!!err}
                      {...register(`emails.${i}.email`)}
                    />
                    {err ? <p className="mt-1 text-xs text-destructive">{err}</p> : null}
                  </div>
                  <Input
                    className="w-24"
                    aria-label={`Email ${i + 1} type`}
                    placeholder="WORK"
                    {...register(`emails.${i}.type`)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove email ${i + 1}`}
                    onClick={() => emails.remove(i)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              );
            })}
          </RowGroup>

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

function RowGroup({
  title,
  addLabel,
  onAdd,
  addDisabled,
  children
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  addDisabled: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onAdd} disabled={addDisabled}>
          <Plus className="size-4" aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
      {children}
    </div>
  );
}
