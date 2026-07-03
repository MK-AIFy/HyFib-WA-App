import { describe, expect, it } from "vitest";
import { getNavItems } from "./nav";

describe("getNavItems", () => {
  it("hides Users and Tenants for a regular agent", () => {
    const ids = getNavItems(["support_agent"]).map((i) => i.id);
    expect(ids).not.toContain("users");
    expect(ids).not.toContain("tenants");
    expect(ids).toContain("settings");
  });

  it("shows Users but not Tenants for a tenant_admin", () => {
    const ids = getNavItems(["tenant_admin"]).map((i) => i.id);
    expect(ids).toContain("users");
    expect(ids).not.toContain("tenants");
  });

  it("shows both Users and Tenants for a platform_owner", () => {
    const ids = getNavItems(["platform_owner"]).map((i) => i.id);
    expect(ids).toContain("users");
    expect(ids).toContain("tenants");
  });

  it("always places Settings last", () => {
    const items = getNavItems(["platform_owner"]);
    expect(items[items.length - 1]?.id).toBe("settings");
  });
});
