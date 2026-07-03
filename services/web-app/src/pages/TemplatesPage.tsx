import type { Template } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { titleCase } from "@/lib/format";
import { useList } from "@/hooks/use-resource";

const STATUS_BADGE = { approved: "green", pending: "yellow", paused: "yellow", rejected: "destructive" } as const;

export function TemplatesPage() {
  const { data, isLoading } = useList<Template>(["templates"], "/api/v1/templates");
  const templates = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Templates" description="Meta-approved message templates for campaigns." />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : templates.length === 0 ? (
          <EmptyState title="No templates" description="Sync approved templates from Meta to see them here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Body</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{titleCase(t.category)}</TableCell>
                  <TableCell>{t.language}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[t.status]}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{t.body}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
