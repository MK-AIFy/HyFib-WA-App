import { hasAnyRole, type AuthContext } from "@hyfib/auth";
import type { Role } from "@hyfib/shared-core";

/** Mirrors the writer set enforced on the contact consent endpoint. */
export const CONTACT_WRITER_ROLES: readonly Role[] = ["platform_owner", "tenant_admin", "marketing_manager"];

/** Support agents may record orders raised during conversations. */
export const ORDER_WRITER_ROLES: readonly Role[] = [
  "platform_owner",
  "tenant_admin",
  "marketing_manager",
  "support_agent"
];

export function canCreateContact(auth: AuthContext): boolean {
  return hasAnyRole(auth, CONTACT_WRITER_ROLES);
}

export function canCreateOrder(auth: AuthContext): boolean {
  return hasAnyRole(auth, ORDER_WRITER_ROLES);
}
