import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { PlatformConfig } from "@hyfib/config";
import type { Role } from "@hyfib/shared-core";

const KNOWN_ROLES: ReadonlySet<Role> = new Set<Role>([
  "platform_owner",
  "tenant_admin",
  "marketing_manager",
  "sales_agent",
  "support_agent",
  "analyst",
  "compliance_auditor"
]);

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
  const raw = payload.realm_access?.roles ?? [];
  return raw.filter((role): role is Role => KNOWN_ROLES.has(role as Role));
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
