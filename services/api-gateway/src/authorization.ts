import { hasAnyRole, normalizeRoles, type AuthContext } from "@hyfib/auth";
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

// ─── User and credential management ───────────────────────────────────────────
// Every route that creates a user, changes a user's roles or status, sets a
// password or mints an API key decides through the functions below:
//  1. Roles are granted top-down. tenant_admin may hand out every role except
//     platform_owner (it need not hold sales_agent to create an agent);
//     platform_owner may be granted only by a signed-in platform_owner.
//  2. API keys are refused outright. A key that creates a user is handed that
//     user's tempPassword, and a key that mints a key, re-roles a user or
//     resets a password leaves access behind that revoking the key does not
//     take away.
//  3. An admin may manage (re-role, suspend, reset the password of) only a user
//     whose every role it could itself have granted, so a tenant_admin cannot
//     touch a platform_owner.
//  4. Nobody changes their own status. A suspended admin whose credential still
//     works must not be able to reactivate itself, and an admin who suspends
//     itself locks itself out; either way it takes a second admin.
//  5. Only an active account signs in or keeps a session (authorizeAccountStatus).

/** resolveAuth gives an API-key caller the subject `apikey:<key id>`; nothing else marks one. */
export const API_KEY_SUBJECT_PREFIX = "apikey:";

/** Roles that administer users and API keys. */
export const USER_ADMIN_ROLES: readonly Role[] = ["platform_owner", "tenant_admin"];

export type AccessDecision = { ok: true } | { ok: false; error: string; detail?: string };

/** The fields of a stored user that decide who may manage it. */
export interface ManagedUser {
  id: string;
  roles: readonly string[];
}

const ALLOWED: AccessDecision = { ok: true };

// Same message the PATCH /users role gate has always returned.
const NOT_A_USER_ADMIN: AccessDecision = { ok: false, error: "Insufficient role" };

const API_KEY_FORBIDDEN: AccessDecision = {
  ok: false,
  error: "api_key_forbidden",
  detail:
    "API keys cannot create users, change a user's roles, status or password, or mint API keys; " +
    "sign in as an administrator to do this."
};

/**
 * Whether two user ids name the same user. A UUID is the same id in either letter case (Postgres compares uuid
 * values, and the routes accept either spelling), so every "is this the caller?" check goes through here; a
 * case-sensitive comparison lets an upper-cased id in a path slip past a rule meant for the caller's own account.
 */
export function isSameUserId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True for a caller authenticated by API key. Any other caller whose subject happens to carry the
 * prefix (a dev-mode x-actor-id, say) is treated as a key too, which only ever removes privileges.
 */
export function isApiKeyCaller(auth: AuthContext): boolean {
  return auth.subject.startsWith(API_KEY_SUBJECT_PREFIX);
}

/** Whether the caller may give `role` to a user: never by API key, and platform_owner only by a platform_owner. */
export function canGrantRole(auth: AuthContext, role: Role): boolean {
  if (isApiKeyCaller(auth)) {
    return false;
  }
  return hasAnyRole(auth, role === "platform_owner" ? ["platform_owner"] : USER_ADMIN_ROLES);
}

/**
 * The requested role names the caller may not grant. Each name is expanded the way a session
 * resolves it (so the "owner" bundle counts as platform_owner and case is ignored), and a name that
 * expands to nothing is refused, so a route that skipped role validation still fails closed.
 */
export function ungrantableRoles(auth: AuthContext, roles: readonly string[]): string[] {
  return roles.filter((role) => {
    const effective = normalizeRoles([role]);
    return effective.length === 0 || !effective.every((granted) => canGrantRole(auth, granted));
  });
}

/**
 * Refuses an API-key caller and passes anyone else. For a route that must look something up before its full
 * decision (set-password needs the target's roles): running this first keeps the key's refusal from depending
 * on the database or revealing whether the id exists. The refusal is the one the full decision gives.
 */
export function authorizeHumanCaller(auth: AuthContext): AccessDecision {
  return isApiKeyCaller(auth) ? API_KEY_FORBIDDEN : ALLOWED;
}

/** Gate for creating or changing users and for minting API keys: a user-admin role, not held by an API key. */
export function authorizeIdentityAdmin(auth: AuthContext): AccessDecision {
  if (!hasAnyRole(auth, USER_ADMIN_ROLES)) {
    return NOT_A_USER_ADMIN;
  }
  return isApiKeyCaller(auth) ? API_KEY_FORBIDDEN : ALLOWED;
}

/** Whether the caller may give a user exactly `roles`, as a new user or as the new set on PATCH. */
export function authorizeRoleGrant(auth: AuthContext, roles: readonly string[]): AccessDecision {
  const gate = authorizeIdentityAdmin(auth);
  if (!gate.ok) {
    return gate;
  }
  const refused = ungrantableRoles(auth, roles);
  if (refused.length > 0) {
    return {
      ok: false,
      error: "role_not_grantable",
      detail: `You cannot grant: ${refused.join(", ")}. Only a signed-in platform_owner can grant platform_owner.`
    };
  }
  return ALLOWED;
}

/**
 * An admin may manage a user only if it could have granted every role the user holds. Stored names
 * are expanded as a session resolves them; one that expands to nothing confers nothing, so it is
 * ignored rather than locking the user away from every admin.
 */
function authorizeManage(auth: AuthContext, target: ManagedUser): AccessDecision {
  const beyondCaller = normalizeRoles(target.roles).filter((role) => !canGrantRole(auth, role));
  if (beyondCaller.length > 0) {
    return {
      ok: false,
      error: "user_not_manageable",
      detail: `This user holds ${beyondCaller.join(", ")}, which you cannot grant, so you cannot change the account.`
    };
  }
  return ALLOWED;
}

const CANNOT_CHANGE_OWN_STATUS: AccessDecision = {
  ok: false,
  error: "cannot_change_own_status",
  detail: "Another administrator must change your account's status."
};

/**
 * PATCH /users/:id. `roles` is the requested new role set, or undefined for a status-only change; `status` is the
 * requested new status, or undefined when the status is not being changed.
 */
export function authorizeUserUpdate(
  auth: AuthContext,
  target: ManagedUser,
  roles: readonly string[] | undefined,
  status?: string
): AccessDecision {
  const gate = authorizeIdentityAdmin(auth);
  if (!gate.ok) {
    return gate;
  }
  if (status !== undefined && isSameUserId(auth.subject, target.id)) {
    return CANNOT_CHANGE_OWN_STATUS;
  }
  const manage = authorizeManage(auth, target);
  if (!manage.ok) {
    return manage;
  }
  return roles ? authorizeRoleGrant(auth, roles) : ALLOWED;
}

/** POST /users/:id/set-password: your own, or as a user admin one you could manage. Never by API key. */
export function authorizePasswordSet(auth: AuthContext, target: ManagedUser): AccessDecision {
  if (isApiKeyCaller(auth)) {
    return API_KEY_FORBIDDEN;
  }
  if (isSameUserId(auth.subject, target.id)) {
    return ALLOWED;
  }
  if (!hasAnyRole(auth, USER_ADMIN_ROLES)) {
    // Same message the route has always returned.
    return { ok: false, error: "Can only change your own password" };
  }
  return authorizeManage(auth, target);
}

// ─── Account status ───────────────────────────────────────────────────────────
// users.status is active, invited, suspended or disabled (the set PATCH /users/:id accepts). Only an active account
// may sign in or authenticate with a session it already holds; every other value, one this code does not know
// included, is refused, so a new status fails closed.

/** The one status that signs in and keeps a session. */
export const ACTIVE_ACCOUNT_STATUS = "active";

// `error` is what the login page shows. "Account is suspended" is the wording /auth/login has always returned.
const INACTIVE_ACCOUNT_MESSAGES: ReadonlyMap<string | undefined, string> = new Map([
  ["suspended", "Account is suspended"],
  ["disabled", "Account is disabled"]
]);

/** Whether an account in `status` may sign in or use a session. A user that was not found (undefined) may not. */
export function authorizeAccountStatus(status: string | undefined): AccessDecision {
  if (status === ACTIVE_ACCOUNT_STATUS) {
    return ALLOWED;
  }
  return { ok: false, error: INACTIVE_ACCOUNT_MESSAGES.get(status) ?? "Account is not active" };
}
