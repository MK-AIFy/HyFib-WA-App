# Local Runbook: Expose the Meta Webhook from a Locally Hosted Stack

## Summary

Meta delivers WhatsApp webhooks (inbound messages, delivery statuses) only to a
public HTTPS callback URL. When the platform runs locally (laptop or an
on-prem host without a public address), use a tunnel to expose
`GET/POST /api/v1/webhooks/meta/whatsapp` to Meta, then register the tunnel URL
in the Meta App Dashboard.

Security still holds through a tunnel: the gateway verifies the
`X-Hub-Signature-256` HMAC against `META_APP_SECRET` on every delivery and the
GET handshake requires `WEBHOOK_VERIFY_TOKEN`, so only payloads signed by your
Meta app are accepted.

## Prerequisites

- Stack running locally: `docker compose up --build -d`
- `.env` contains the **real** values from your Meta app (placeholder values
  will fail verification):
  - `META_APP_SECRET` — App Dashboard → App settings → Basic → App secret
  - `WEBHOOK_VERIFY_TOKEN` — any strong random string you choose
- The api-gateway answers locally: `curl http://localhost:18080/health`

> Tunnel to port **18080** (api-gateway direct), not 443. The edge proxy
> serves a self-signed certificate and rejects curl-like user agents, both of
> which interfere with tunnel/webhook traffic. The gateway performs full HMAC
> verification itself, so this does not weaken webhook security.

## Option A: ngrok

```bash
ngrok http 18080
```

Copy the `https://<random>.ngrok-free.app` forwarding URL.

> The free tier issues a new hostname on every restart — re-save the callback
> URL in the Meta App Dashboard each time the tunnel restarts.

## Option B: cloudflared (no account required)

```bash
cloudflared tunnel --url http://localhost:18080
```

Copy the `https://<random>.trycloudflare.com` URL from the output.

## Register the callback with Meta

1. Meta App Dashboard → your app → **WhatsApp → Configuration → Webhook**.
2. Callback URL: `https://<tunnel-host>/api/v1/webhooks/meta/whatsapp`
3. Verify token: the value of `WEBHOOK_VERIFY_TOKEN` from `.env`.
4. Click **Verify and save** — Meta sends `GET ...?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
   and the gateway echoes the challenge on success.
5. Under **Webhook fields**, subscribe to `messages` (covers inbound messages
   and delivery statuses).

## Validate

1. Send a WhatsApp message from a handset to your business number.
2. Watch it flow through the pipeline:

```bash
docker compose logs -f api-gateway webhook-ingestor notification-worker
```

Expected log events: `webhook_ingested` (ingestor), then `inbound_recorded`
(worker).

3. Confirm it is queryable through the API (and visible live on the SSE
   stream):

```bash
# History (dev header identity shown; use a bearer token when AUTH_ENABLED=true)
curl -s http://localhost:18080/api/v1/conversations \
  -H "x-tenant-id: <TENANT_ID>" -H "x-role: tenant_admin"

# Live stream of inbound + status events for the tenant
curl -N http://localhost:18080/api/v1/events/stream \
  -H "x-tenant-id: <TENANT_ID>" -H "x-role: tenant_admin"
```

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `403 Webhook verification failed` on save | `WEBHOOK_VERIFY_TOKEN` in `.env` does not match the token entered in the dashboard; restart the gateway after changing `.env`. |
| `401 Invalid webhook signature` in gateway logs | `META_APP_SECRET` mismatch, or something between Meta and the gateway rewrote the body. Tunnel directly to 18080 and copy the App secret exactly. |
| `200 {"status":"duplicate_ignored"}` | The same signed payload was already processed (24h idempotency window) — expected on Meta retries. |
| `403` from curl through `https://localhost` | The edge proxy blocks curl-like user agents (`$is_bot` map). Test against `localhost:18080` or send a browser user agent. |
| Handshake works but no message events arrive | The `messages` webhook field is not subscribed, or the WABA is not subscribed to the app (`POST /internal/v1/whatsapp/subscribe-app`, see the onboarding runbook). |

## Production note

Tunnels are for development only. For production, give the host a public DNS
name with a CA-signed certificate on the edge proxy and restrict sources to
Meta's CIDR ranges (see `docs/runbooks/meta-webhook-cidr-allowlist.md`).
