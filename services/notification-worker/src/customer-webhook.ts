import { createHmac } from "node:crypto";
import {
  OutboundUrlBlockedError,
  createOutboundFetch,
  validateOutboundUrl,
  type OutboundAllowlist,
  type OutboundAllowlistRemedy
} from "@hyfib/shared-core";

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
 * never follows a redirect. The operator allowlist (OUTBOUND_WEBHOOK_ALLOWLIST,
 * passed in `options`) applies to both, so the re-check and the connection
 * agree with each other and with the gateway's save-time check.
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
  /** On a block: which OUTBOUND_WEBHOOK_ALLOWLIST entry kind could permit it; absent when none can. */
  remedy?: OutboundAllowlistRemedy;
}

export interface CustomerWebhookOptions {
  /**
   * Operator allowlist (config.outboundWebhookAllowlist). Applied to the URL
   * re-check and to the default transport; omitted or empty means none.
   */
  allowlist?: OutboundAllowlist;
}

/** DNS-rebinding-safe transport that never follows redirects (see @hyfib/shared-core outbound-url). */
const guardedFetch: CustomerWebhookFetch = createOutboundFetch();

/** One guarded transport per allowlist object (config's is created once), so it is compiled once. */
const allowlistedFetches = new WeakMap<OutboundAllowlist, CustomerWebhookFetch>();

function defaultTransport(allowlist: OutboundAllowlist | undefined): CustomerWebhookFetch {
  if (allowlist === undefined) {
    return guardedFetch;
  }
  let transport = allowlistedFetches.get(allowlist);
  if (transport === undefined) {
    transport = createOutboundFetch({ allowlist });
    allowlistedFetches.set(allowlist, transport);
  }
  return transport;
}

/**
 * The operator-facing hint logged beside a blocked delivery: which allowlist
 * entry could permit it, or that none can. Never contains the URL.
 */
export function customerWebhookBlockHint(remedy: OutboundAllowlistRemedy | undefined): string {
  if (remedy === "host") {
    return (
      "operator: if this receiver is meant to be on a private network, add its host name to " +
      "OUTBOUND_WEBHOOK_ALLOWLIST — the address it resolves to must be allowlisted too " +
      "(docs/runbooks/outbound-webhook-allowlist.md)"
    );
  }
  if (remedy === "address") {
    return (
      // The exact address, not "its CIDR": entries match only their own address family, so the natural range for
      // an IPv6-wrapped IPv4 address (10.0.0.0/8 for [::ffff:10.0.0.1]) would not admit it.
      "operator: if this receiver is meant to be on a private network, add this exact address to " +
      "OUTBOUND_WEBHOOK_ALLOWLIST, written as it appears here (a /32 or /128 entry) " +
      "(docs/runbooks/outbound-webhook-allowlist.md)"
    );
  }
  return (
    "cannot be allowlisted (scheme, credentials, malformed host, or a link-local/metadata, multicast or " +
    "reserved address): the tenant must change the callback URL"
  );
}

/** `sha256=<hmac-hex>` over the exact raw body — verify with timing-safe compare. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function blockedResult(error: string, remedy: OutboundAllowlistRemedy | undefined): CustomerWebhookResult {
  return remedy === undefined ? { ok: false, blocked: true, error } : { ok: false, blocked: true, error, remedy };
}

export async function deliverCustomerWebhook(
  target: { url: string; secret?: string },
  event: CustomerWebhookEvent,
  fetchImpl?: CustomerWebhookFetch,
  options: CustomerWebhookOptions = {}
): Promise<CustomerWebhookResult> {
  const destination = validateOutboundUrl(target.url, { allowlist: options.allowlist });
  if (!destination.ok) {
    return blockedResult(destination.error, destination.remedy);
  }
  const transport = fetchImpl ?? defaultTransport(options.allowlist);
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "HyFib-Webhook/1.0"
  };
  if (target.secret) {
    headers["x-hyfib-signature"] = signWebhookBody(target.secret, body);
  }
  try {
    const response = await transport(target.url, {
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
      return blockedResult(error.message, error.remedy);
    }
    return { ok: false };
  }
}
