import type { Tenant } from "@hyfib/shared-core";

/**
 * Stable anchor tenant for platform-level (non-customer) users, seeded by
 * 013_auth.sql. Fresh installs with no ORG_TENANT_ID pin and no other
 * tenants resolve to this row.
 */
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface OrgResolutionDeps {
  listTenants: () => Promise<Tenant[]>;
  getTenantById: (id: string) => Promise<Tenant | undefined>;
  updateTenant: (id: string, patch: { name: string }) => Promise<Tenant | undefined>;
  env: { orgTenantId?: string; orgName?: string };
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Resolves the single organization this deployment serves. This is a
 * single-organization gateway: there is exactly one tenant, and boot must
 * fail loudly (throw) rather than run ambiguously against zero or many.
 *
 * Resolution order:
 *   1. `env.orgTenantId` set → must resolve via getTenantById, or throw.
 *   2. Otherwise → exactly one active tenant among listTenants(); use it
 *      (fresh installs: the seeded PLATFORM_TENANT_ID row).
 *   3. Otherwise (zero or multiple active tenants) → throw, asking the
 *      operator to set ORG_TENANT_ID.
 *
 * After resolving, if `env.orgName` is set and differs from the resolved
 * tenant's name, renames the tenant and returns the updated row.
 */
export async function resolveOrgTenant(deps: OrgResolutionDeps): Promise<Tenant> {
  const pinnedId = deps.env.orgTenantId?.trim();
  let org: Tenant;

  if (pinnedId) {
    const found = await deps.getTenantById(pinnedId);
    if (!found) {
      throw new Error(`single_org: ORG_TENANT_ID=${pinnedId} not found in tenants table`);
    }
    org = found;
  } else {
    const tenants = await deps.listTenants();
    const active = tenants.filter((tenant) => tenant.status === "active");
    if (active.length !== 1) {
      throw new Error(`single_org: expected exactly one tenant, found ${active.length}; set ORG_TENANT_ID`);
    }
    org = active[0]!;
  }

  deps.log("single_org: resolved org tenant", {
    tenantId: org.id,
    name: org.name,
    source: pinnedId ? "env" : "active_scan"
  });

  const desiredName = deps.env.orgName?.trim();
  if (desiredName && desiredName !== org.name) {
    const updated = await deps.updateTenant(org.id, { name: desiredName });
    deps.log("single_org: renamed org tenant", { tenantId: org.id, from: org.name, to: desiredName });
    org = updated ?? { ...org, name: desiredName };
  }

  return org;
}
