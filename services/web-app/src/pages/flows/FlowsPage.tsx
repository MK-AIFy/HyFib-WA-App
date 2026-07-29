import { useState } from "react";
import type { Team } from "@hyfib/shared-core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { useList } from "@/hooks/use-resource";
import { buildDefinition, nextNodeId, type NodeDraft } from "./flow-builder";

interface FlowListItem {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  triggerKeyword?: string;
  activeSessions: number;
}

const STATUS_BADGE = { draft: "gray", active: "green", paused: "yellow" } as const;

export function FlowsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useList<FlowListItem>(["flows"], "/api/v1/flows");
  const flows = data?.items ?? [];

  function act(id: string, action: "activate" | "pause") {
    api
      .post(`/api/v1/flows/${id}/${action}`, {})
      .then(() => {
        toast.success(action === "activate" ? "Flow activated" : "Flow paused");
        void qc.invalidateQueries({ queryKey: ["flows"] });
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Chatbot flows"
        description="Keyword-triggered bot conversations with branching, tagging and human handoff."
        action={<CreateFlow />}
      />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : flows.length === 0 ? (
          <EmptyState title="No flows" description="Create a flow and activate it to start the bot." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Active sessions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.map((flow) => (
                <TableRow key={flow.id}>
                  <TableCell className="font-medium">{flow.name}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[flow.status]}>{flow.status}</Badge>
                  </TableCell>
                  <TableCell>{flow.triggerKeyword ?? "—"}</TableCell>
                  <TableCell>{flow.activeSessions}</TableCell>
                  <TableCell className="text-right">
                    {flow.status === "active" ? (
                      <Button size="sm" variant="outline" onClick={() => act(flow.id, "pause")}>
                        Pause
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => act(flow.id, "activate")}>
                        Activate
                      </Button>
                    )}
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

const EMPTY_DRAFT: NodeDraft = { id: "", type: "message", text: "", next: "" };

function CreateFlow() {
  const qc = useQueryClient();
  const { data: teams } = useList<Team>(["teams"], "/api/v1/teams");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [startId, setStartId] = useState("");
  const [drafts, setDrafts] = useState<NodeDraft[]>([]);
  const [saving, setSaving] = useState(false);

  function patchDraft(index: number, patch: Partial<NodeDraft>) {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  function addDraft() {
    setDrafts((current) => {
      const draft = { ...EMPTY_DRAFT, id: nextNodeId(current) };
      const next = [...current, draft];
      if (next.length === 1) {
        setStartId(draft.id);
      }
      return next;
    });
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    const definition = buildDefinition(startId, drafts);
    if (!definition.ok) {
      toast.error(definition.error);
      return;
    }
    setSaving(true);
    api
      .post("/api/v1/flows", {
        name: name.trim(),
        ...(trigger.trim() ? { triggerKeyword: trigger.trim() } : {}),
        definition: definition.value
      })
      .then(() => {
        toast.success("Flow created — activate it to go live");
        setOpen(false);
        setName("");
        setTrigger("");
        setDrafts([]);
        setStartId("");
        void qc.invalidateQueries({ queryKey: ["flows"] });
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"))
      .finally(() => setSaving(false));
  }

  const stepIds = drafts.map((d) => d.id);
  const targetSelect = (value: string | undefined, onChange: (v: string) => void, placeholder: string) => (
    <Select value={value || "__end__"} onValueChange={(v) => onChange(v === "__end__" ? "" : v)}>
      <SelectTrigger className="w-40">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__end__">(end flow)</SelectItem>
        {stepIds.map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New flow</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New chatbot flow</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flow-name">Name</Label>
              <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flow-trigger">Trigger keyword (optional)</Label>
              <Input
                id="flow-trigger"
                placeholder='e.g. "menu"'
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
              />
            </div>
          </div>

          {drafts.map((draft, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Step ${index + 1} id`}
                  className="w-32"
                  value={draft.id}
                  onChange={(e) => patchDraft(index, { id: e.target.value })}
                />
                <Select
                  value={draft.type}
                  onValueChange={(type) => patchDraft(index, { type: type as NodeDraft["type"] })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="message">Send message</SelectItem>
                    <SelectItem value="question">Ask question</SelectItem>
                    <SelectItem value="add_tag">Add tag</SelectItem>
                    <SelectItem value="assign_team">Handoff to team</SelectItem>
                    <SelectItem value="end">End</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>

              {(draft.type === "message" || draft.type === "question") && (
                <Textarea
                  aria-label={`Step ${index + 1} text`}
                  placeholder={draft.type === "question" ? "Question to ask" : "Message to send"}
                  value={draft.text ?? ""}
                  onChange={(e) => patchDraft(index, { text: e.target.value })}
                />
              )}
              {draft.type === "add_tag" && (
                <Input
                  aria-label={`Step ${index + 1} tag`}
                  placeholder="Tag to add"
                  value={draft.tag ?? ""}
                  onChange={(e) => patchDraft(index, { tag: e.target.value })}
                />
              )}
              {draft.type === "assign_team" && (
                <Select value={draft.teamId ?? ""} onValueChange={(teamId) => patchDraft(index, { teamId })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Team to hand off to" />
                  </SelectTrigger>
                  <SelectContent>
                    {(teams?.items ?? []).map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {draft.type === "question" && (
                <div className="flex flex-col gap-2">
                  {(draft.branches ?? []).map((branch, bIndex) => (
                    <div key={bIndex} className="flex items-center gap-2">
                      <Input
                        aria-label={`Step ${index + 1} branch ${bIndex + 1} reply`}
                        className="w-32"
                        placeholder="Reply"
                        value={branch.match}
                        onChange={(e) =>
                          patchDraft(index, {
                            branches: (draft.branches ?? []).map((b, i) =>
                              i === bIndex ? { ...b, match: e.target.value } : b
                            )
                          })
                        }
                      />
                      <span className="text-xs text-muted-foreground">goes to</span>
                      {targetSelect(
                        branch.next,
                        (next) =>
                          patchDraft(index, {
                            branches: (draft.branches ?? []).map((b, i) => (i === bIndex ? { ...b, next } : b))
                          }),
                        "Target"
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        patchDraft(index, { branches: [...(draft.branches ?? []), { match: "", next: "" }] })
                      }
                    >
                      Add branch
                    </Button>
                    <span className="text-xs text-muted-foreground">If no branch matches:</span>
                    {targetSelect(
                      draft.fallbackNext,
                      (fallbackNext) => patchDraft(index, { fallbackNext }),
                      "Fallback"
                    )}
                  </div>
                </div>
              )}

              {draft.type !== "question" && draft.type !== "end" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Then</span>
                  {targetSelect(draft.next, (next) => patchDraft(index, { next }), "Next step")}
                </div>
              )}
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={addDraft}>
              Add step
            </Button>
            {drafts.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Start at:</span>
                <Select value={startId} onValueChange={setStartId}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Start step" />
                  </SelectTrigger>
                  <SelectContent>
                    {stepIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving || drafts.length === 0}>
            Create flow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
