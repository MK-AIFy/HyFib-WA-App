import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSendMessage } from "@/hooks/use-conversations";
import { Field } from "./Field";
import { locationSchema, toLocationBody, type LocationValues } from "./schemas";
import { sendErrorMessage } from "./send-error";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Sends a WhatsApp location pin. Coordinates are typed by hand (no map picker this iteration). */
export function LocationDialog({ conversationId, open, onOpenChange }: Props) {
  const send = useSendMessage(conversationId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<LocationValues>({ resolver: zodResolver(locationSchema) });

  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function onSubmit(values: LocationValues) {
    send.mutate(toLocationBody(values), {
      onSuccess: () => {
        toast.success("Location sent");
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
          <DialogTitle>Send a location</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude" id="loc-lat" error={errors.latitude?.message}>
              <Input
                id="loc-lat"
                inputMode="decimal"
                placeholder="e.g. 12.9716"
                aria-invalid={!!errors.latitude}
                {...register("latitude")}
              />
            </Field>
            <Field label="Longitude" id="loc-lng" error={errors.longitude?.message}>
              <Input
                id="loc-lng"
                inputMode="decimal"
                placeholder="e.g. 77.5946"
                aria-invalid={!!errors.longitude}
                {...register("longitude")}
              />
            </Field>
          </div>
          <Field label="Name (optional)" id="loc-name" error={errors.name?.message}>
            <Input id="loc-name" aria-invalid={!!errors.name} {...register("name")} />
          </Field>
          <Field label="Address (optional)" id="loc-address" error={errors.address?.message}>
            <Input id="loc-address" aria-invalid={!!errors.address} {...register("address")} />
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
