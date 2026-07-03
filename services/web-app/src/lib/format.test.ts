import { describe, expect, it } from "vitest";
import { initials, timeAgo, titleCase } from "./format";

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
});
