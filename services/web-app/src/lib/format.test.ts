import { describe, expect, it } from "vitest";
import { formatBytes, initials, timeAgo, titleCase } from "./format";

describe("format", () => {
  it("initials from a two-word name", () => {
    expect(initials("Jane Smith")).toBe("JS");
  });
  it("initials falls back to last two phone digits", () => {
    expect(initials(undefined, "+15551234567")).toBe("67");
  });
  it("timeAgo returns 'now' for recent times", () => {
    expect(timeAgo(new Date().toISOString())).toBe("now");
  });
  it("timeAgo empty for undefined", () => {
    expect(timeAgo()).toBe("");
  });
  it("titleCase converts snake_case", () => {
    expect(titleCase("marketing_manager")).toBe("Marketing Manager");
  });
  it("formatBytes renders B, KB and MB with one decimal above KB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
});
