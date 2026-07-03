import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";

interface UsageRow {
  date: string;
  direction: "inbound" | "outbound";
  category: string;
  count: number;
}

/** Pivots the flat usage rows into per-date inbound/outbound totals. */
export function pivotUsage(rows: UsageRow[]): { date: string; inbound: number; outbound: number }[] {
  const byDate = new Map<string, { date: string; inbound: number; outbound: number }>();
  for (const r of rows) {
    const entry = byDate.get(r.date) ?? { date: r.date, inbound: 0, outbound: 0 };
    entry[r.direction] += r.count;
    byDate.set(r.date, entry);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function UsagePage() {
  const [days, setDays] = useState("7");
  const { data, isLoading } = useQuery({
    queryKey: ["usage", days],
    queryFn: () => api.get<{ items: UsageRow[] }>(`/api/v1/usage?days=${days}`)
  });
  const chartData = useMemo(() => pivotUsage(data?.items ?? []), [data]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        title="Usage"
        description="Message volume by direction."
        action={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["7", "14", "30", "60", "90"].map((d) => (
                <SelectItem key={d} value={d}>
                  {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Daily volume</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No usage data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                  <XAxis dataKey="date" stroke="#8b949e" fontSize={11} />
                  <YAxis stroke="#8b949e" fontSize={11} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8 }}
                    labelStyle={{ color: "#e6edf3" }}
                  />
                  <Legend />
                  <Bar dataKey="inbound" fill="#25d366" />
                  <Bar dataKey="outbound" fill="#58a6ff" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
