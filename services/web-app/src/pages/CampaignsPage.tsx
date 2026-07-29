import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Campaign, CampaignRecipient, Segment, Template } from "@hyfib/shared-core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { useCreate, useList } from "@/hooks/use-resource";
import { campaignActions, type CampaignAction } from "./campaign-actions";

const STATUS_BADGE = {
  draft: "gray",
  scheduled: "blue",
  running: "blue",
  paused: "yellow",
  completed: "green",
  cancelled: "destructive"
} as const;

const ACTION_SUCCESS: Record<CampaignAction, string> = {
  run: "Campaign started",
  pause: "Campaign paused",
  resume: "Campaign resumed",
  cancel: "Campaign cancelled"
};

export function CampaignsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useList<Campaign>(["campaigns"], "/api/v1/campaigns");
  const campaigns = data?.items ?? [];

  function act(id: string, action: CampaignAction) {
    api
      .post<{ recipientCount?: number }>(`/api/v1/campaigns/${id}/${action}`, {})
      .then((body) => {
        const suffix =
          action === "run" && body?.recipientCount !== undefined ? ` (${body.recipientCount} recipients)` : "";
        toast.success(`${ACTION_SUCCESS[action]}${suffix}`);
        void qc.invalidateQueries({ queryKey: ["campaigns"] });
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Campaigns"
        description="Template broadcasts with policy enforcement."
        action={<CreateCampaign />}
      />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : campaigns.length === 0 ? (
          <EmptyState title="No campaigns" description="Create a campaign to broadcast a template to a segment." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[c.status]}>{c.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {campaignActions(c.status).map((action) =>
                        action === "cancel" ? (
                          <CancelCampaign key={action} name={c.name} onConfirm={() => act(c.id, "cancel")} />
                        ) : (
                          <Button
                            key={action}
                            size="sm"
                            variant={action === "pause" ? "outline" : "default"}
                            onClick={() => act(c.id, action)}
                          >
                            {action === "run" ? "Run" : action === "pause" ? "Pause" : "Resume"}
                          </Button>
                        )
                      )}
                      <CampaignReport campaign={c} />
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

function CancelCampaign({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Pending sends are retired and the campaign cannot be restarted. Messages already sent are unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep campaign</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Cancel campaign</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface CampaignReportBody {
  campaign: Campaign;
  funnel: Record<string, number>;
  recipients: CampaignRecipient[];
}

const FUNNEL_ORDER = ["pending", "sent", "delivered", "read", "failed", "policy_skipped", "cancelled"] as const;

function CampaignReport({ campaign }: { campaign: Campaign }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<CampaignReportBody>({
    queryKey: ["campaigns", campaign.id, "report"],
    queryFn: () => api.get<CampaignReportBody>(`/api/v1/campaigns/${campaign.id}/report`),
    enabled: open
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{campaign.name} — delivery report</DialogTitle>
        </DialogHeader>
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {FUNNEL_ORDER.map((key) => (
                <div key={key} className="rounded-md border p-2 text-center">
                  <div className="text-lg font-semibold">{data.funnel[key] ?? 0}</div>
                  <div className="text-xs text-muted-foreground">{key.replace("_", " ")}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.recipients.length} recipient{data.recipients.length === 1 ? "" : "s"} shown (first 500).
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface NewCampaign {
  name: string;
  templateId: string;
  segmentId: string;
}

function CreateCampaign() {
  const [open, setOpen] = useState(false);
  const { data: templates } = useList<Template>(["templates"], "/api/v1/templates");
  const { data: segments } = useList<Segment>(["segments"], "/api/v1/segments");
  const create = useCreate<NewCampaign>(["campaigns"], "/api/v1/campaigns");
  const { register, handleSubmit, setValue, reset } = useForm<NewCampaign>();

  function onSubmit(v: NewCampaign) {
    create.mutate(v, {
      onSuccess: () => {
        toast.success("Campaign created");
        reset();
        setOpen(false);
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : "Failed")
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New campaign</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <input type="hidden" {...register("templateId", { required: true })} />
          <input type="hidden" {...register("segmentId", { required: true })} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" {...register("name", { required: true })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Template</Label>
            <Select onValueChange={(v) => setValue("templateId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select template" />
              </SelectTrigger>
              <SelectContent>
                {(templates?.items ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Segment</Label>
            <Select onValueChange={(v) => setValue("segmentId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select segment" />
              </SelectTrigger>
              <SelectContent>
                {(segments?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
