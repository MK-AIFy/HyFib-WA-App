# Event Architecture

The platform uses RabbitMQ for asynchronous, durable, at-least-once eventing,
fronted by a transactional outbox so domain state and emitted events are atomic.

## Transport

- **Exchange**: durable topic exchange `hyfib.events`; routing key = topic
  (e.g. `campaign.dispatch.requested`).
- **Publishing**: persistent messages via a **confirm channel** (the publisher
  waits for the broker ack). Implemented in `packages/event-bus`
  (`RabbitMqEventBus`).
- **Consuming**: each consumer binds a **durable, named queue** (consumer group)
  to a topic with **manual ack**. On handler error the message is retried once
  (requeue) and then **dead-lettered** to `hyfib.events.dlx` → `<queue>.dlq`.
- **Resilience**: automatic reconnect with exponential backoff; consumers are
  re-established on reconnect.
- **Transport selection**: `createEventBus(config)` returns the RabbitMQ bus in
  normal operation, or an in-process `InMemoryEventBus` when `EVENT_BUS=memory`
  (tests/dev).

## Transactional outbox

Producers never publish directly from request handlers. Instead:

1. Within the same DB transaction as the domain change, a row is written to
   `outbox_events` (`outboxRepository.enqueue`).
2. The **relay** (a loop in `api-gateway`) claims pending rows via the
   `outbox_claim` `SECURITY DEFINER` function (`FOR UPDATE SKIP LOCKED`, with
   2-minute reclaim of stuck `processing` rows), publishes them to RabbitMQ, then
   calls `outbox_mark_processed`.

This guarantees an event is emitted iff the transaction committed, and survives
broker outages (rows stay `pending`). Delivery is at-least-once; consumers are
idempotent.

## Topics

| Topic | Producer | Consumer | Effect |
|-------|----------|----------|--------|
| `campaign.dispatch.requested` | api-gateway (outbox) | notification-worker | send template, persist outbound message |
| `campaign.dispatch.result` | notification-worker | notification-worker (stats) | dispatch outcome → campaign tally |
| `whatsapp.outbound.requested` | api-gateway (outbox) | notification-worker | send free-form session reply (text/media), persist outbound message |
| `whatsapp.inbound.received` | webhook-ingestor | notification-worker | upsert contact/conversation, store full inbound message, mark read |
| `whatsapp.status.updated` | webhook-ingestor | notification-worker | update message status + merge pricing/conversation/error metadata |
| `template.status.updated` | api-gateway (template sync) | (projection/metrics) | local template reconciled with Meta |
| `compliance.optout.event` | api-gateway / notification-worker | (projection) | contact opted out |

## WhatsApp message coverage

**Sending** (via `meta-adapter`, each call carrying the channel's number + token):

- **Templates** — positional body params or structured components (header
  text/media, body text/currency/date_time, button url/quick-reply).
- **Session messages** — free-form `text` and `media` (image/video/audio/
  document/sticker, by link or media id), plus `interactive` button/list menus.
- **Read receipts** — `mark-read` is sent best-effort for each inbound message.

**Receiving** — the webhook normalizer captures text, media (id/mime/sha256/
caption/filename), interactive button & list replies, template quick-reply
buttons, location, reactions, contacts, ad referrals and message context, plus
the sender's WhatsApp profile name. A derived text summary keeps STOP/START
opt-out detection working across every message type.

**Per-tenant credentials** — `whatsapp_channels` may store an AES-256-GCM
encrypted access token (`CHANNEL_ENCRYPTION_KEY`); the worker uses it per send,
falling back to the env token when absent (single-WABA dev).

**Template sync** — `POST /channels/whatsapp/:id/sync-templates` pulls the WABA's
templates from Meta and reconciles local status/category/body.

## Idempotency

- **Dispatch**: `campaign_send_log` unique `(tenant, campaign, phone)` claimed
  before send; released on failure so redelivery can retry.
- **Webhooks**: dedupe by `messageId[:status]` (24h TTL) in `webhook-ingestor`.
- **Status/inbound**: keyed on the Meta `external_message_id`.

## Tenant resolution for system consumers

Inbound/status events carry a Meta `phone_number_id` but no tenant context. The
consumer maps it to `(tenant_id, channel_id)` via the
`resolve_channel_by_phone_number_id` `SECURITY DEFINER` function, then performs
all writes under that tenant's RLS context.
