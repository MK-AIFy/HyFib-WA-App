import type { AutomationRule } from "@hyfib/shared-core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { titleCase } from "@/lib/format";
import { useList } from "@/hooks/use-resource";

interface AutoReplyRule {
  id: string;
  keyword?: string;
  replyText?: string;
  enabled: boolean;
}

export function AutomationPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Automation" description="Trigger-based rules and auto-replies." />
      <div className="flex-1 overflow-auto p-4">
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Automation rules</TabsTrigger>
            <TabsTrigger value="auto-reply">Auto-replies</TabsTrigger>
          </TabsList>
          <TabsContent value="rules">
            <RulesTable />
          </TabsContent>
          <TabsContent value="auto-reply">
            <AutoReplyTable />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function RulesTable() {
  const qc = useQueryClient();
  const { data, isLoading } = useList<AutomationRule>(["automation-rules"], "/api/v1/automation-rules");
  const rules = data?.items ?? [];

  function toggle(id: string, enabled: boolean) {
    api
      .patch(`/api/v1/automation-rules/${id}`, { enabled })
      .then(() => void qc.invalidateQueries({ queryKey: ["automation-rules"] }))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
  }

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (rules.length === 0) return <EmptyState title="No automation rules" />;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Enabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell>{titleCase(r.triggerType)}</TableCell>
            <TableCell>{titleCase(r.actionType)}</TableCell>
            <TableCell>
              <Switch checked={r.enabled} onCheckedChange={(v) => toggle(r.id, v)} aria-label={`Toggle ${r.name}`} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AutoReplyTable() {
  const { data, isLoading } = useList<AutoReplyRule>(["auto-reply-rules"], "/api/v1/auto-reply-rules");
  const rules = data?.items ?? [];

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (rules.length === 0) return <EmptyState title="No auto-reply rules" />;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Keyword</TableHead>
          <TableHead>Reply</TableHead>
          <TableHead>Enabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono text-xs">{r.keyword ?? "—"}</TableCell>
            <TableCell className="max-w-md truncate text-muted-foreground">{r.replyText}</TableCell>
            <TableCell>{r.enabled ? "Yes" : "No"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
