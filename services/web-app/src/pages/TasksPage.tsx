import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Task } from "@hyfib/shared-core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useCreate, useList } from "@/hooks/use-resource";

const STATUS_BADGE = { open: "yellow", done: "green", cancelled: "gray" } as const;

export function TasksPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useList<Task>(["tasks"], "/api/v1/tasks");
  const tasks = data?.items ?? [];

  function setStatus(id: string, status: "done" | "cancelled") {
    api
      .patch(`/api/v1/tasks/${id}`, { status })
      .then(() => void qc.invalidateQueries({ queryKey: ["tasks"] }))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Tasks" description="Follow-ups and reminders." action={<CreateTask />} />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <EmptyState title="No tasks" description="Create a task to track a follow-up." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.title}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[t.status]}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.dueAt ? timeAgo(t.dueAt) : "—"}</TableCell>
                  <TableCell className="text-right">
                    {t.status === "open" ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setStatus(t.id, "done")}>
                          Done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setStatus(t.id, "cancelled")}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
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

interface NewTask {
  title: string;
  dueAt?: string;
}

function CreateTask() {
  const [open, setOpen] = useState(false);
  const create = useCreate<{ title: string; dueAt?: string }>(["tasks"], "/api/v1/tasks");
  const { register, handleSubmit, reset } = useForm<NewTask>();

  function onSubmit(v: NewTask) {
    create.mutate(
      { title: v.title, dueAt: v.dueAt ? new Date(v.dueAt).toISOString() : undefined },
      {
        onSuccess: () => {
          toast.success("Task created");
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
        <Button>New task</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" {...register("title", { required: true })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dueAt">Due date</Label>
            <Input id="dueAt" type="datetime-local" {...register("dueAt")} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
