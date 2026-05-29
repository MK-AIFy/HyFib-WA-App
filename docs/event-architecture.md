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
| `campaign.dispatch.result` | notification-worker | (projection/metrics) | dispatch outcome |
| `whatsapp.inbound.received` | webhook-ingestor | notification-worker | upsert contact/conversation, store inbound message |
| `whatsapp.status.updated` | webhook-ingestor | notification-worker | update message status by external id |

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
