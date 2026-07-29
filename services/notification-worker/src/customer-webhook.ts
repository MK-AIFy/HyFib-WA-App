import { createHmac } from "node:crypto";

/**
 * Outbound customer webhooks (roadmap Phase D): POSTs message events to the
 * tenant's configured status_callback_url, HMAC-signed with their per-tenant
 * secret so receivers can authenticate the caller — the mirror of how HyFib
 * itself verifies Meta's webhooks. Pure/injectable for tests; delivery is
 * fire-and-forget at the call sites so a slow receiver never blocks the
 * message pipeline.
 */

export interface CustomerWebhookEvent {
  type: "message.status" | "message.inbound";
  occurredAt: string;
  data: Record<string, unknown>;
}

/** `sha256=<hmac-hex>` over the exact raw body — verify with timing-safe compare. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export async function deliverCustomerWebhook(
  target: { url: string; secret?: string },
  event: CustomerWebhookEvent,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status?: number }> {
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
      signal: AbortSignal.timeout(10_000)
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}
