import type { ServerResponse } from "node:http";

type Labels = Record<string, string>;

interface Counter {
  help: string;
  series: Map<string, number>;
}

const counters = new Map<string, Counter>();

function seriesKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

/** Increment (creating if needed) a Prometheus counter series. */
export function incCounter(name: string, help: string, labels: Labels = {}, value = 1): void {
  let counter = counters.get(name);
  if (!counter) {
    counter = { help, series: new Map() };
    counters.set(name, counter);
  }
  const key = seriesKey(labels);
  counter.series.set(key, (counter.series.get(key) ?? 0) + value);
}

/** Renders all counters plus basic process gauges in Prometheus text format. */
export function renderMetrics(): string {
  const lines: string[] = [
    "# HELP process_uptime_seconds Process uptime in seconds.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
    "# HELP process_resident_memory_bytes Resident memory size in bytes.",
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${process.memoryUsage().rss}`
  ];
  for (const [name, counter] of counters) {
    lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
    for (const [key, value] of counter.series) {
      lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sendMetrics(res: ServerResponse): void {
  const body = renderMetrics();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}
