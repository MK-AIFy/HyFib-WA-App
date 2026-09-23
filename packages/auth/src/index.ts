import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
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

/**
 * The credential could not be checked, as opposed to being refused: verification reached no verdict on the token
 * because something it depends on failed — most often the identity provider's signing keys (JWKS) could not be
 * fetched: connection refused, timed out, an error status, a response that is not a key set. The same token may be
 * accepted once that recovers, so this is deliberately not an AuthError, which callers answer with 401 and clients
 * take as "sign in again". `cause` is the underlying error, for a caller that classifies it further (the gateway
 * answers 503 only for outage shapes it recognises).
 */
export class AuthUnavailableError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "AuthUnavailableError";
  }
}

/**
 * jose's codes for a verdict on the token itself: expired, badly signed, for another issuer or audience, malformed,
 * signed under a key id the realm does not publish, or with an algorithm this deployment does not accept. Only these
 * are refusals (AuthError); anything else thrown while verifying means no verdict was reached.
 */
const TOKEN_VERDICT_CODES: ReadonlySet<string> = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JWK_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWE_INVALID",
  "ERR_JWE_DECRYPTION_FAILED"
]);

function isTokenVerdict(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && TOKEN_VERDICT_CODES.has(code);
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

export interface AuthenticatorOptions {
  /**
   * Resolves the key a token was signed with. Defaults to the realm's remote JWKS (`config.keycloak.jwksUri`); tests
   * inject one to exercise failures that are slow to provoke over the network, such as a fetch timeout.
   */
  keySet?: JWTVerifyGetKey;
}

/**
 * Builds an authenticator that validates Keycloak-issued JWTs against the
 * realm's published JWKS. Signature, issuer, audience and expiry are all
 * enforced by `jwtVerify`; there is no header-based trust fallback.
 *
 * A refused token throws AuthError (401). A token that could not be checked,
 * because the JWKS could not be fetched, throws AuthUnavailableError instead.
 */
export function createAuthenticator(config: PlatformConfig, options: AuthenticatorOptions = {}): Authenticator {
  const jwks: JWTVerifyGetKey = options.keySet ?? createRemoteJWKSet(new URL(config.keycloak.jwksUri));

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
        const detail = error instanceof Error ? error.message : "verification failed";
        if (isTokenVerdict(error)) {
          throw new AuthError(`Invalid token: ${detail}`);
        }
        throw new AuthUnavailableError(`Token could not be verified: ${detail}`, { cause: error });
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
