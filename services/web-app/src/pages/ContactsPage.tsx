import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Contact } from "@hyfib/shared-core";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { readStoredToken } from "@/lib/auth-storage";
import { useCreate, useList } from "@/hooks/use-resource";

interface NewContact {
  phoneE164: string;
  firstName?: string;
  lastName?: string;
}

export function ContactsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useList<Contact>(
    ["contacts", { search }],
    `/api/v1/contacts?q=${encodeURIComponent(search)}`
  );
  const contacts = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Contacts"
        description="Your customer directory with consent tracking."
        action={
          <div className="flex gap-2">
            <ExportButton />
            <AddContactDialog />
          </div>
        }
      />
      <div className="border-b border-border p-3">
        <Input
          placeholder="Search by name or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
          aria-label="Search contacts"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : contacts.length === 0 ? (
          <EmptyState title="No contacts" description="Add a contact or import a CSV to get started." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.phoneE164}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <Badge key={t} variant="gray">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {c.optedOut ? <Badge variant="destructive">Opted out</Badge> : <Badge variant="green">Active</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ExportButton() {
  async function download() {
    try {
      const res = await fetch("/api/v1/contacts/export", {
        headers: { authorization: `Bearer ${readStoredToken() ?? ""}` }
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export failed");
    }
  }
  return (
    <Button variant="secondary" onClick={download}>
      Export CSV
    </Button>
  );
}

function AddContactDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreate<NewContact>(["contacts"], "/api/v1/contacts");
  const { register, handleSubmit, reset } = useForm<NewContact>();

  function onSubmit(values: NewContact) {
    create.mutate(values, {
      onSuccess: () => {
        toast.success("Contact added");
        reset();
        setOpen(false);
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : "Failed")
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add contact</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="phoneE164">Phone (E.164)</Label>
            <Input id="phoneE164" placeholder="+15551234567" {...register("phoneE164", { required: true })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" {...register("firstName")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" {...register("lastName")} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
