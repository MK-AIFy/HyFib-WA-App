import type { Tenant } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { titleCase } from "@/lib/format";
import { useList } from "@/hooks/use-resource";

export function TenantsPage() {
  const { data, isLoading } = useList<Tenant>(["tenants"], "/api/v1/tenants");
  const tenants = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Tenants" description="Organizations on the platform." />
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : tenants.length === 0 ? (
          <EmptyState title="No tenants" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Max users</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    <Badge variant="blue">{titleCase(t.plan)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.maxUsers}</TableCell>
                  <TableCell>
                    <Badge variant={t.status === "active" ? "green" : "destructive"}>{t.status}</Badge>
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
