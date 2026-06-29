# A6 Findings: Webhook + Meta Adapter

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| Webhook token verify (GET) | PASS | `verifyWebhookToken` uses `timingSafeEqual`; returns `hub.challenge` on match, 403 on mismatch | services/api-gateway/src/index.ts:959-973 |
| Webhook POST raw body captured before JSON parse | PASS | `readRawBody(req)` called before any JSON parse; body is UTF-8 string | services/api-gateway/src/index.ts:983 |
| HMAC verified with `verifyMetaSignature` (gateway) | PASS | Uses `createHmac("sha256", appSecret)`, `timingSafeEqual`; checks `sha256=` prefix; rejects if no header | packages/shared-core/src/security.ts:3-16 |
| Gateway idempotency check | PARTIAL | Keyed on `webhook:${normalizedSignature}` — dedupes at webhook level but in-memory only; multi-instance deployments share no state | services/api-gateway/src/index.ts:988 |
| `resolveChannelByPhoneNumberId` called at ingest | GAP | Gateway does NOT call `resolveChannelByPhoneNumberId` during webhook POST. Channel resolution is deferred to notification-worker's `handleInbound`. Tenant routing at gateway edge is absent. | services/api-gateway/src/index.ts:976-1001 |
| Event published to bus/queue | PASS | Gateway proxies to webhook-ingestor via HTTP; ingestor publishes `EventTopics.WhatsAppInboundReceived` and `EventTopics.WhatsAppStatusUpdated` | services/webhook-ingestor/src/index.ts:79-101 |
| Webhook-ingestor HMAC re-verification | PASS | Re-verifies `verifyMetaSignature(rawBody, normalizedSignature, config.metaAppSecret)` on forwarded request; rejects with 401 if invalid | services/webhook-ingestor/src/index.ts:151-155 |
| `normalize.ts` called | PASS | `normalizeInbound(value, message, entry.id)` and `normalizeStatus(value, status, entry.id)` called for each message/status | services/webhook-ingestor/src/index.ts:81, 99 |
| RabbitMQ publish correct exchange + routing key | PASS | Exchange `hyfib.events` (topic), routing key = topic string (`whatsapp.inbound.received`); matches `bindQueue` in event-bus consumer | packages/event-bus/src/index.ts:67, 96, 142 |
| Ingestor idempotency store | PASS | Per-`message.id` key (`inbound:${message.id}`), 24h TTL; skips duplicate wamid | services/webhook-ingestor/src/index.ts:69-72 |
| `inbound:1` log emitted | GAP | No specific `inbound:1` counter/log emitted. `incCounter("events_published_total", ...)` is emitted per publish, and `webhook_ingested` info log includes inbound count. No per-message structured "inbound:1" log. | services/webhook-ingestor/src/index.ts:76-83, 161-167 |
| Normalize: text messages | PASS | `case "text"` → `message.text?.body` | services/webhook-ingestor/src/normalize.ts:106 |
| Normalize: image/video/audio/document/sticker | PASS | All handled via `mapMedia(mediaSource)`; mediaSource selects first defined media field | services/webhook-ingestor/src/normalize.ts:140-143 |
| Normalize: location | PASS | `message.location` mapped fully (lat/lng/name/address) | services/webhook-ingestor/src/normalize.ts:163-170 |
| Normalize: contacts | PASS | `message.contacts` passed through as `unknown[]` | services/webhook-ingestor/src/normalize.ts:175-177 |
| Normalize: interactive (button_reply, list_reply) | PASS | Both `button_reply` and `list_reply` handled with `kind` discriminant | services/webhook-ingestor/src/normalize.ts:146-159 |
| Normalize: button | PASS | `message.button` mapped to `{ payload, text }` | services/webhook-ingestor/src/normalize.ts:161-163 |
| Normalize: reaction | PASS | `message.reaction` mapped with `messageId` rename | services/webhook-ingestor/src/normalize.ts:172-174 |
| Normalize: output matches EventEnvelope shape | PASS | `normalizeInbound` returns `NormalizedInboundEvent`; spread into eventBus.publish payload; `EventEnvelope` wraps it at bus level | services/webhook-ingestor/src/index.ts:81 |
| AMQP routing: ingestor publish routing key matches worker consume queue | PASS | Ingestor publishes on topic `"whatsapp.inbound.received"`; event-bus `bindQueue(queueName, EXCHANGE, topic)` — queue `"inbound-messages"` is bound to topic `"whatsapp.inbound.received"`. No mismatch. | packages/event-bus/src/index.ts:142; services/notification-worker/src/index.ts:715 |
| Idempotency: duplicate wamid returns 200 + duplicate_ignored | PARTIAL | Gateway returns `{ status: "duplicate_ignored" }` at the HTTP level; ingestor returns duplicate count in summary. However, the idempotency stores are in-memory (not Redis) — multi-instance deployments will not share state, so duplicate protection is per-pod only. | services/api-gateway/src/index.ts:988-990; services/webhook-ingestor/src/index.ts:69-72 |
| Meta-adapter text send: correct endpoint + auth | PASS | `POST /{phoneNumberId}/messages`, `Authorization: Bearer <token>`; uses `config.whatsappGraphVersion` (default v22.0) | services/meta-adapter/src/index.ts:94, 191 |
| Meta-adapter template send: components array shape | PASS | `buildTemplateBody` produces `{ messaging_product, to, type: "template", template: { name, language, components } }`. Falls back to a single `body` positional parameter component when no structured components supplied. | services/meta-adapter/src/graph-messages.ts:22-46 |
| Meta-adapter media upload: returns mediaId | PASS | `POST /{phoneNumberId}/media` with multipart form; returns `{ mediaId: parsed.id }` on 201 | services/meta-adapter/src/index.ts:625-673 |
| Error on missing access token: 503 (not 500) | PASS | `graphRequest` throws `"No WhatsApp access token configured"`; caught in `dispatchSend` catch → `sendJson(res, 503, ...)` | services/meta-adapter/src/index.ts:116-117, 201-204 |
| Graph API version pinned | PASS | `config.whatsappGraphVersion` (env `WHATSAPP_GRAPH_VERSION`, default `"v22.0"`); used in `rawGraphRequest` URL | services/meta-adapter/src/index.ts:94; packages/config/src/index.ts:186 |
| Circuit breaker on Graph API | PASS | Opens after 5 consecutive failures, 30s cooldown; respected before each graphRequest | services/meta-adapter/src/index.ts:57-62, 119-121 |
| Auth header format | PASS | `Authorization: Bearer ${accessToken ?? config.whatsappAccessToken}` | services/meta-adapter/src/index.ts:94 |

---

## Issues (GAP / PARTIAL / BUG only)

### 1. `resolveChannelByPhoneNumberId` not called at gateway ingest — GAP

**File:** `services/api-gateway/src/index.ts:976-1001`

**Detail:** The webhook POST handler reads the raw body, verifies HMAC, checks idempotency, then HTTP-proxies the full payload to the ingestor without resolving the receiving channel or tenant. The `resolveChannelByPhoneNumberId` call that does exist in the gateway (`line 888`) is in the SSE-forwarding path only. Tenant routing from `phoneNumberId` happens only later in `notification-worker/handleInbound`.

**Impact:** No per-tenant early rejection at the gateway edge. A valid Meta webhook arriving for an unknown/inactive phone number will still flow into RabbitMQ before being silently discarded by the worker (`inbound_unroutable` warning). This is a minor operational gap (no early 404) rather than a security hole, since HMAC is already verified.

---

### 2. In-memory `IdempotencyStore` — PARTIAL (multi-instance gap)

**File:** `packages/shared-core/src/idempotency.ts:1-31`; used in `services/api-gateway/src/index.ts:223` and `services/webhook-ingestor/src/index.ts:39`

**Detail:** `IdempotencyStore` is a `Map<string, number>` — entirely in-process memory. There is no Redis or distributed backing store. Running two or more replicas of either the api-gateway or webhook-ingestor means each pod has an independent store. A Meta retry delivered to a different replica will not be detected as a duplicate.

**Impact:** Duplicate inbound messages can be processed and persisted (double conversation messages, double opt-out events) when pods scale horizontally. The automation template at-least-once guard (`redis.set("atreq:...", "NX", "EX")`) in notification-worker is correctly Redis-backed, but the ingest layer is not.

**Recommended fix:** Replace `IdempotencyStore` with a Redis `SET NX EX` check, or use the PostgreSQL `messages` table's `external_message_id` unique constraint as the dedup gate before publishing.

---

### 3. No `inbound:1` structured log per message — GAP

**File:** `services/webhook-ingestor/src/index.ts:76-83`

**Detail:** The audit spec requires a per-message `inbound:1` log entry. The ingestor emits an `incCounter("events_published_total")` metric per publish and a single `webhook_ingested` log at the end summarising `{ inbound, statuses, duplicates }`. There is no per-message structured log event (e.g., `logger.info("inbound:1", { messageId, from, type })`).

**Impact:** Message-level traceability gaps in log aggregation. Cannot correlate a specific inbound wamid to a log line in the ingestor without looking at the notification-worker's `inbound_recorded` log.

---

### 4. Gateway webhook idempotency key is the HMAC signature — PARTIAL

**File:** `services/api-gateway/src/index.ts:988`

**Detail:** Idempotency key is `webhook:${normalizedSignature}` (the raw `x-hub-signature-256` header). Two distinct payloads could theoretically produce the same HMAC if the app secret is weak, but this is not exploitable in practice. More importantly, this key deduplicates the full webhook body, not individual `wamid` values. A batch payload containing 10 messages will be treated as one unit — if it is retried, all 10 are re-delivered; the ingestor-level per-`wamid` idempotency (in-memory) must catch the individual duplicates. This coupling is fragile in a multi-replica setup (see issue #2).

**Impact:** Duplicate suppression at the HTTP level (gateway) and at the message level (ingestor) are both in-memory and non-shared across replicas.
