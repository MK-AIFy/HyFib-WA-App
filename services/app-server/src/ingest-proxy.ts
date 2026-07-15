import type { IngestWebhookProxy } from "@hyfib/api-gateway";

/**
 * Builds the in-process IngestWebhookProxy the modular monolith injects into
 * the gateway (replacing the standalone HTTP hop to the webhook-ingestor).
 *
 * Extracted from main() so the contract is unit-testable: `status` mirrors
 * what the standalone HTTP path would report (200 accepted / 401 invalid
 * signature) so gateway failure logs (webhook_upstream_failed) can
 * distinguish signature rejections from processing errors on both paths.
 */
export function createIngestWebhookProxy(
  processWebhook: (forwarded: {
    rawBody: string;
    signature?: string;
    tenantId?: string;
  }) => Promise<{ verified: boolean; summary: object }>
): IngestWebhookProxy {
  return async (forwarded) => {
    const { verified, summary } = await processWebhook(forwarded);
    return {
      ok: verified,
      body: { status: verified ? "accepted" : "invalid_signature", ...summary },
      status: verified ? 200 : 401
    };
  };
}
