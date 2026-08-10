import { useState } from "react";
import { LayoutTemplate, Link2, MapPin, Plus, UserSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ContactCardDialog } from "./ContactCardDialog";
import { CtaUrlDialog } from "./CtaUrlDialog";
import { LocationDialog } from "./LocationDialog";
import { TemplatePickerDialog } from "./TemplatePickerDialog";

type DialogKind = "template" | "cta" | "location" | "contact";

/**
 * The composer "+" attachment menu. Opens one of four send dialogs. The dialogs
 * are rendered as siblings of the menu (not nested inside it) so the menu's
 * close-on-select focus handling doesn't fight the dialog's open transition.
 */
export function AttachMenu({ conversationId }: { conversationId: string }) {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const closeIf = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Attach">
            <Plus className="size-5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setDialog("template")}>
            <LayoutTemplate className="size-4" aria-hidden="true" />
            Template
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("cta")}>
            <Link2 className="size-4" aria-hidden="true" />
            Link button
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("location")}>
            <MapPin className="size-4" aria-hidden="true" />
            Location
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("contact")}>
            <UserSquare className="size-4" aria-hidden="true" />
            Contact card
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TemplatePickerDialog conversationId={conversationId} open={dialog === "template"} onOpenChange={closeIf} />
      <CtaUrlDialog conversationId={conversationId} open={dialog === "cta"} onOpenChange={closeIf} />
      <LocationDialog conversationId={conversationId} open={dialog === "location"} onOpenChange={closeIf} />
      <ContactCardDialog conversationId={conversationId} open={dialog === "contact"} onOpenChange={closeIf} />
    </>
  );
}
