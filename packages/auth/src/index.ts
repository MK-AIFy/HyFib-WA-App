import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { PlatformConfig } from "@hyfib/config";
import type { Role } from "@hyfib/shared-core";

export type CrmRole = "owner" | "admin" | "agent" | "viewer";

// Source of truth for JWT role expansion. Keep in sync with infra/postgres/init/008_seed_phase1.sql.
const CRM_ROLE_BUNDLES: Readonly<Record<CrmRole, readonly Role[]>> = {
  owner: ["platform_owner", "tenant_admin", "marketing_manager", "sales_agent", "support_agent"],
  admin: ["tenant_admin", "marketing_manager"],
  agent: ["sales_agent", "support_agent"],
  viewer: ["analyst", "compliance_auditor"]
};

const KNOWN_ROLES: ReadonlySet<Role> = new Set<Role>([
  "platform_owner",
  "tenant_admin",
  "marketing_manager",
  "sales_agent",
  "support_agent",
  "analyst",
  "compliance_auditor"
]);

const KNOWN_CRM_ROLES: ReadonlySet<CrmRole> = new Set<CrmRole>(["owner", "admin", "agent", "viewer"]);

export interface AuthContext {
  subject: string;
  tenantId?: string;
  roles: Role[];
  email?: string;
}

export class AuthError extends Error {
  public readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

interface KeycloakClaims extends JWTPayload {
  tenant_id?: string;
  email?: string;
  realm_access?: { roles?: string[] };
}

function extractRoles(payload: KeycloakClaims): Role[] {
  return normalizeRoles(payload.realm_access?.roles ?? []);
}

export function normalizeRoles(rawRoles: readonly string[]): Role[] {
  const normalized = new Set<Role>();
  for (const rawRole of rawRoles) {
    const role = rawRole.trim().toLowerCase();
    if (!role) {
      continue;
    }
    if (KNOWN_ROLES.has(role as Role)) {
      normalized.add(role as Role);
      continue;
    }
    if (KNOWN_CRM_ROLES.has(role as CrmRole)) {
      for (const expandedRole of CRM_ROLE_BUNDLES[role as CrmRole]) {
        normalized.add(expandedRole);
      }
    }
  }
  return [...normalized];
}

export interface Authenticator {
  /** Verifies a `Authorization: Bearer <jwt>` header and returns the caller context. */
  authenticate(authorizationHeader: string | string[] | undefined): Promise<AuthContext>;
}

/**
 * Builds an authenticator that validates Keycloak-issued JWTs against the
 * realm's published JWKS. Signature, issuer, audience and expiry are all
 * enforced by `jwtVerify`; there is no header-based trust fallback.
 */
export function createAuthenticator(config: PlatformConfig): Authenticator {
  const jwks = createRemoteJWKSet(new URL(config.keycloak.jwksUri));

  return {
    async authenticate(authorizationHeader): Promise<AuthContext> {
      const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
      if (!header || !header.startsWith("Bearer ")) {
        throw new AuthError("Missing or malformed Authorization header");
      }
      const token = header.slice("Bearer ".length).trim();
      if (!token) {
        throw new AuthError("Empty bearer token");
      }

      let payload: KeycloakClaims;
      try {
        const verified = await jwtVerify<KeycloakClaims>(token, jwks, {
          issuer: config.keycloak.issuer,
          audience: config.keycloak.audience
        });
        payload = verified.payload;
      } catch (error) {
        throw new AuthError(`Invalid token: ${error instanceof Error ? error.message : "verification failed"}`);
      }

      if (!payload.sub) {
        throw new AuthError("Token missing subject");
      }

      return {
        subject: payload.sub,
        tenantId: payload.tenant_id,
        roles: extractRoles(payload),
        email: payload.email
      };
    }
  };
}

export function hasAnyRole(ctx: AuthContext, allowed: readonly Role[]): boolean {
  return ctx.roles.some((role) => allowed.includes(role));
}
