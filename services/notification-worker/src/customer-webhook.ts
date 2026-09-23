import { createHmac } from "node:crypto";
import { OutboundUrlBlockedError, createOutboundFetch, validateOutboundUrl } from "@hyfib/shared-core";

/**
 * Outbound customer webhooks (roadmap Phase D): POSTs message events to the
 * tenant's configured status_callback_url, HMAC-signed with their per-tenant
 * secret so receivers can authenticate the caller — the mirror of how HyFib
 * itself verifies Meta's webhooks. Pure/injectable for tests; delivery is
 * fire-and-forget at the call sites so a slow receiver never blocks the
 * message pipeline.
 *
 * The URL is tenant-controlled, so every delivery goes through the shared
 * outbound-URL guard (SSRF): the stored URL is re-validated here — rows saved
 * before save-time validation existed are never re-checked anywhere else —
 * and the default transport vets every resolved address at connect time and
 * never follows a redirect.
 */

export interface CustomerWebhookEvent {
  type: "message.status" | "message.inbound";
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * The transport seam. Fetch-shaped so the global fetch or a test double still
 * fits; `redirect: "manual"` asks any WHATWG fetch not to follow redirects.
 */
export type CustomerWebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "manual" }
) => Promise<{ ok: boolean; status: number }>;

export interface CustomerWebhookResult {
  ok: boolean;
  status?: number;
  /** Set when the outbound-URL guard refused the destination; `error` says why (never the secret). */
  blocked?: boolean;
  error?: string;
}

/** DNS-rebinding-safe transport that never follows redirects (see @hyfib/shared-core outbound-url). */
const guardedFetch: CustomerWebhookFetch = createOutboundFetch();

/** `sha256=<hmac-hex>` over the exact raw body — verify with timing-safe compare. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export async function deliverCustomerWebhook(
  target: { url: string; secret?: string },
  event: CustomerWebhookEvent,
  fetchImpl: CustomerWebhookFetch = guardedFetch
): Promise<CustomerWebhookResult> {
  const destination = validateOutboundUrl(target.url);
  if (!destination.ok) {
    return { ok: false, blocked: true, error: destination.error };
  }
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "HyFib-Webhook/1.0"
  };
  if (target.secret) {
    headers["x-hyfib-signature"] = signWebhookBody(target.secret, body);
  }
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual"
    });
    // A 3xx is a failed delivery: following it would let the receiver steer
    // the signed POST to an address the guard never vetted.
    const redirected = response.status >= 300 && response.status < 400;
    return { ok: response.ok && !redirected, status: response.status };
  } catch (error) {
    if (error instanceof OutboundUrlBlockedError) {
      return { ok: false, blocked: true, error: error.message };
    }
    return { ok: false };
  }
}
