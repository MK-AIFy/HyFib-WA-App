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

/** The error's `code` (jose's, or a Node system error's), if it has one. */
export function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export function isTokenVerdict(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TOKEN_VERDICT_CODES.has(code);
}
