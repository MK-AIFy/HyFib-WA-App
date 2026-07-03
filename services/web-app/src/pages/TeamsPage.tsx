import type { Team } from "@hyfib/shared-core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { timeAgo } from "@/lib/format";
import { useList } from "@/hooks/use-resource";

export function TeamsPage() {
  const { data, isLoading } = useList<Team>(["teams"], "/api/v1/teams");
  const teams = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Teams" description="Queues for routing conversations." />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : teams.length === 0 ? (
          <EmptyState title="No teams" description="Teams let you route conversations to a queue." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.isDefault ? "Yes" : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{timeAgo(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
