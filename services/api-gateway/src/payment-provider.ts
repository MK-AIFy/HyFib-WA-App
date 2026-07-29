/**
 * Payment-link creation (roadmap G16, provider integration). Razorpay's
 * Payment Links API is the first adapter; the seam is the tiny
 * PaymentLinkResult contract, so a Stripe/PayU adapter is another branch of
 * createPaymentLink. Config-gated (PAYMENT_PROVIDER=none disables everything)
 * and best-effort at the call site: link creation failure never blocks an
 * order transition — operators can always attach a link manually via the
 * existing PATCH /orders/:id.
 *
 * Verified at the wire-shape level with an injectable fetch — the same
 * standard the WhatsApp Graph adapter first shipped with; live verification
 * happens when real keys are configured.
 */

export interface PaymentLinkRequest {
  amountMinor: number;
  currency: string;
  description: string;
  /** Our order id — round-trips as Razorpay's reference_id for reconciliation. */
  referenceId: string;
}

export type PaymentLinkResult = { ok: true; link: string; providerRef: string } | { ok: false; error: string };

/** Razorpay POST /v1/payment_links body (amounts already in minor units). */
export function buildRazorpayPaymentLinkBody(request: PaymentLinkRequest): Record<string, unknown> {
  return {
    amount: request.amountMinor,
    currency: request.currency,
    description: request.description.slice(0, 255),
    reference_id: request.referenceId,
    notify: { sms: false, email: false }
  };
}

export async function createRazorpayPaymentLink(
  credentials: { keyId: string; keySecret: string },
  request: PaymentLinkRequest,
  fetchImpl: typeof fetch = fetch
): Promise<PaymentLinkResult> {
  if (!credentials.keyId || !credentials.keySecret) {
    return { ok: false, error: "razorpay_not_configured" };
  }
  try {
    const response = await fetchImpl("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`
      },
      body: JSON.stringify(buildRazorpayPaymentLinkBody(request)),
      signal: AbortSignal.timeout(10_000)
    });
    const body = (await response.json()) as { id?: string; short_url?: string; error?: { description?: string } };
    if (!response.ok || !body.short_url || !body.id) {
      return { ok: false, error: body.error?.description ?? `razorpay_error_${response.status}` };
    }
    return { ok: true, link: body.short_url, providerRef: body.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network_error" };
  }
}
