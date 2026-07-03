import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard, StatGrid } from "@/components/StatCard";
import { api } from "@/lib/api";

interface Overview {
  totals?: Record<string, number>;
  last14Days?: { date: string; count: number }[];
}

const KPIS: [string, string][] = [
  ["conversations", "Conversations"],
  ["contacts", "Contacts"],
  ["templates", "Templates"],
  ["campaigns", "Campaigns"],
  ["messagesInbound", "Inbound"],
  ["messagesOutbound", "Outbound"],
  ["messagesFailed", "Failed"]
];

export function ReportsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["reports-overview"],
    queryFn: () => api.get<Overview>("/api/v1/reports/overview")
  });
  const totals = data?.totals ?? {};
  const daily = data?.last14Days ?? [];

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader title="Reports" description="Key metrics and 14-day message trend." />
      <div className="flex flex-col gap-4 p-4 md:p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <StatGrid>
              {KPIS.map(([key, label]) => (
                <StatCard key={key} label={label} value={totals[key] ?? 0} />
              ))}
            </StatGrid>
            <Card>
              <CardHeader>
                <CardTitle>Messages — last 14 days</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {daily.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No message data yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={daily} margin={{ left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                      <XAxis dataKey="date" stroke="#8b949e" fontSize={11} />
                      <YAxis stroke="#8b949e" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8 }}
                        labelStyle={{ color: "#e6edf3" }}
                      />
                      <Area type="monotone" dataKey="count" stroke="#25d366" fill="#25d366" fillOpacity={0.2} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
