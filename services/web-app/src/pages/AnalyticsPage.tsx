import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard, StatGrid } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";

interface AuditItem {
  id: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  occurredAt?: string;
  createdAt?: string;
}

const KPIS: [string, string][] = [
  ["contacts", "Contacts"],
  ["templates", "Templates"],
  ["campaigns", "Campaigns"],
  ["conversations", "Conversations"]
];

export function AnalyticsPage() {
  const analytics = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api.get<{ totals?: Record<string, number> }>("/api/v1/analytics")
  });
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<{ items: AuditItem[] }>("/api/v1/audit")
  });
  const totals = analytics.data?.totals ?? {};
  const events = (audit.data?.items ?? []).slice(0, 60);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader title="Analytics" description="Workspace activity overview." />
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <StatGrid>
          {KPIS.map(([key, label]) => (
            <StatCard key={key} label={label} value={totals[key] ?? 0} />
          ))}
        </StatGrid>
        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {events.length === 0 ? (
              <EmptyState title="No audit events yet" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Resource</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {timeAgo(e.occurredAt ?? e.createdAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.action}</TableCell>
                      <TableCell className="text-muted-foreground">{e.resourceType ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
