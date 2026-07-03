import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Segment } from "@hyfib/shared-core";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { useCreate, useList } from "@/hooks/use-resource";

interface NewSegment {
  name: string;
  tags?: string;
  country?: string;
}

export function SegmentsPage() {
  const { data, isLoading } = useList<Segment>(["segments"], "/api/v1/segments");
  const segments = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Segments" description="Reusable audiences for campaigns." action={<CreateSegment />} />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : segments.length === 0 ? (
          <EmptyState title="No segments" description="Create a segment to target a campaign audience." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Filters</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(s.definition.tags ?? []).map((t) => (
                        <Badge key={t} variant="gray">
                          {t}
                        </Badge>
                      ))}
                      {s.definition.country ? <Badge variant="blue">{s.definition.country}</Badge> : null}
                      {s.definition.optedInOnly ? <Badge variant="green">Opted-in</Badge> : null}
                    </div>
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

function CreateSegment() {
  const [open, setOpen] = useState(false);
  const create = useCreate<{ name: string; definition: Segment["definition"] }>(["segments"], "/api/v1/segments");
  const { register, handleSubmit, reset } = useForm<NewSegment>();

  function onSubmit(v: NewSegment) {
    create.mutate(
      {
        name: v.name,
        definition: {
          tags: v.tags ? v.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          country: v.country || undefined
        }
      },
      {
        onSuccess: () => {
          toast.success("Segment created");
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
        <Button>New segment</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New segment</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" {...register("name", { required: true })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input id="tags" placeholder="vip, active" {...register("tags")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="country">Country</Label>
            <Input id="country" placeholder="US" {...register("country")} />
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
