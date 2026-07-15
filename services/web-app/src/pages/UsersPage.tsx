import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Role, User } from "@hyfib/shared-core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { titleCase } from "@/lib/format";
import { useCreate, useList } from "@/hooks/use-resource";

const ROLES: Role[] = [
  "tenant_admin",
  "marketing_manager",
  "sales_agent",
  "support_agent",
  "analyst",
  "compliance_auditor"
];

export function UsersPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useList<User>(["users"], "/api/v1/users");
  const users = data?.items ?? [];

  function toggleStatus(u: User) {
    const status = u.status === "active" ? "suspended" : "active";
    api
      .patch(`/api/v1/users/${u.id}`, { status })
      .then(() => void qc.invalidateQueries({ queryKey: ["users"] }))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Users" description="Team members and their roles." action={<InviteUser />} />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <Badge key={r} variant="blue">
                          {titleCase(r)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === "active" ? "green" : "gray"}>{u.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => toggleStatus(u)}>
                      {u.status === "active" ? "Suspend" : "Reactivate"}
                    </Button>
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

interface InviteForm {
  displayName: string;
  email: string;
  role: Role;
}

function InviteUser() {
  const [open, setOpen] = useState(false);
  const create = useCreate<{ email: string; displayName: string; roles: Role[] }, { tempPassword?: string }>(
    ["users"],
    "/api/v1/users"
  );
  const { register, handleSubmit, setValue, reset } = useForm<InviteForm>({ defaultValues: { role: "support_agent" } });

  function onSubmit(v: InviteForm) {
    create.mutate(
      { email: v.email, displayName: v.displayName, roles: [v.role] },
      {
        onSuccess: (res) => {
          toast.success(res?.tempPassword ? `Invited. Temp password: ${res.tempPassword}` : "User invited");
          reset();
          setOpen(false);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Failed")
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Invite user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="displayName">Name</Label>
            <Input id="displayName" {...register("displayName", { required: true })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...register("email", { required: true })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <Select defaultValue="support_agent" onValueChange={(v) => setValue("role", v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {titleCase(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
