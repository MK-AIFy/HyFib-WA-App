import { describe, expect, it } from "vitest";
import { pivotUsage } from "./UsagePage";

describe("pivotUsage", () => {
  it("groups counts per date by direction", () => {
    const rows = [
      { date: "2026-07-01", direction: "inbound" as const, category: "service", count: 3 },
      { date: "2026-07-01", direction: "outbound" as const, category: "marketing", count: 5 },
      { date: "2026-07-01", direction: "inbound" as const, category: "utility", count: 2 },
      { date: "2026-07-02", direction: "outbound" as const, category: "marketing", count: 1 }
    ];
    expect(pivotUsage(rows)).toEqual([
      { date: "2026-07-01", inbound: 5, outbound: 5 },
      { date: "2026-07-02", inbound: 0, outbound: 1 }
    ]);
  });

  it("returns empty for no rows", () => {
    expect(pivotUsage([])).toEqual([]);
  });
});
