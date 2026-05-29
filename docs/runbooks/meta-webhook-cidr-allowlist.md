# Runbook: Meta Webhook Source Allowlisting

Defence in depth for the webhook endpoint. The signature HMAC
(`X-Hub-Signature-256`, verified with `META_APP_SECRET`) is the primary control;
IP allowlisting reduces exposure to spray/abuse traffic.

## nginx allowlist (edge)

Add to the `location /api/v1/webhooks/meta/whatsapp` block in
`infra/nginx/nginx.conf` (keep the list updated from Meta's published ranges):

```nginx
# Meta/Facebook published egress ranges — update on a schedule.
allow 31.13.24.0/21;
allow 66.220.144.0/20;
allow 69.63.176.0/20;
allow 173.252.64.0/18;
allow 157.240.0.0/16;
deny all;
```

> Meta does not guarantee a small static set; obtain current ranges from
> Meta's AS32934 advertisements and review monthly. Maintain in change control.

## Application defence (already in place)

- HMAC signature verification (`packages/shared-core/src/security.ts`).
- Idempotency dedupe on `(messageId[:status])` (24h TTL).
- Stricter rate-limit zone `webhook_limit` at the edge.

## Verify

A request with a valid signature but a disallowed source IP must be rejected by
nginx (403) before reaching the gateway; a valid source with a bad signature
must be rejected (401) by the gateway.
