# A4 Findings: Campaigns + Templates

| Feature | Status | Evidence | File:Line |
|---|---|---|---|
| List templates (GET /templates) | PARTIAL | Returns ALL statuses; no approved-only filter for dispatch path; UI filters client-side | api-gateway/src/index.ts:1404-1407 |
| Sync templates (POST /channels/whatsapp/:id/sync-templates) | PASS | Role-gated (owner/admin/marketing), calls meta-adapter with channel access token, handles missing token gracefully | api-gateway/src/index.ts:1311-1332 |
| Create template (POST /templates) | PASS | Role-gated, body validated (name≤512, valid category, language≤10, body≤1024), status forced to "pending" | api-gateway/src/index.ts:1409-1453 |
| Create campaign (POST /campaigns) | PARTIAL | `contactIds` param absent — only `segmentId` accepted; name+templateId required; validates ratePerMinute/quietHours/frequencyCap; enforces marketing-only template constraint | api-gateway/src/index.ts:1877-1940 |
| Campaign category gate | PASS | Gateway rejects non-marketing templates at creation (`template.category !== "marketing"` → 422) | api-gateway/src/index.ts:1915-1918 |
| List campaigns (GET /campaigns) | PASS | Paginated (limit/offset), returns total, no status filter required | api-gateway/src/index.ts:1877-1882 |
| Campaign recipients (GET /campaigns/:id/recipients) | GAP | No standalone GET /campaigns/:id/recipients route; recipients only returned via GET /campaigns/:id/report (limited to 500 rows) | api-gateway/src/index.ts:2014-2031 |
| Dispatch — test send (POST /campaigns/:id/dispatch) | PASS | Role-gated, E.164 validated, calls dispatchCampaign() with full policy evaluation per contact | api-gateway/src/index.ts:1943-1977 |
| Dispatch — fan-out run (POST /campaigns/:id/run) | PASS | Role-gated, calls runCampaign(); filterSendableContacts() applied; template.status=approved enforced; segment required | api-gateway/src/index.ts:1980-2011 |
| Consent gating | PASS | Both dispatchCampaign() and handleCampaignRun() check hasActiveConsent via consentRepository | api-gateway/src/index.ts:379, notification-worker/src/index.ts:287 |
| Opted-out filter (filterSendableContacts) | PASS | Pure function in campaign.ts; applied in both runCampaign and scheduler fan-out before enqueueing | api-gateway/src/campaign.ts:18-21 |
| Policy engine applied per-recipient | PASS | handleCampaignRun applies evaluateOutboundPolicy() per contact in the fan-out loop | notification-worker/src/index.ts:293-312 |
| Policy engine — quiet hours logic | PASS | isInsideQuietHours handles midnight-crossing correctly (startHour > endHour case) | packages/policy-engine/src/index.ts:66-72 |
| Policy engine — frequency cap query | PASS | frequencyCapSince computed once per run, batch-loaded via countOutboundSinceBatch; correct time window | notification-worker/src/index.ts:252-271 |
| Policy engine — template category enforcement | PASS | evaluateOutboundPolicy checks template.category !== requestedCategory → blocked | packages/policy-engine/src/index.ts:48-50 |
| MARKETING blocked during quiet hours | PASS | Quiet hours check is unconditional of category; applies to all including MARKETING | packages/policy-engine/src/index.ts:52-54 |
| AMQP queue names — gateway publishes CampaignRunRequested | PASS | Topic: "campaign.run.requested" (EventTopics.CampaignRunRequested) | packages/shared-core/src/index.ts:525 |
| AMQP queue names — worker subscribes CampaignRunRequested | PASS | Queue: "campaign-run", topic: EventTopics.CampaignRunRequested — matches publisher | notification-worker/src/index.ts:714 |
| AMQP queue names — gateway publishes CampaignDispatchRequested | PASS | Topic: "campaign.dispatch.requested" (EventTopics.CampaignDispatchRequested) | packages/shared-core/src/index.ts:523 |
| AMQP queue names — worker subscribes CampaignDispatchRequested | PASS | Queue: "campaign-dispatch", topic: EventTopics.CampaignDispatchRequested — matches | notification-worker/src/index.ts:712 |
| DLQ configured | PASS | RabbitMqEventBus asserts DLX exchange and `.dlq` queue for all durable subscriptions; nacks dead messages after one retry | packages/event-bus/src/index.ts:140-145, 166-167 |
| Worker retry logic | PASS | On handler throw: nack with requeue=true on first delivery, requeue=false (→ DLQ) on redelivery | packages/event-bus/src/index.ts:166-168 |
| Variable personalisation — resolveVariables | PASS | Resolves 1-based {{N}} indices from VariableMapping; supports field names and {literal} objects | notification-worker/src/personalize.ts:33-53 |
| Variable personalisation — fallback for missing vars | PASS | Falls back to empty string `""` for undefined specs or missing contact fields | notification-worker/src/personalize.ts:43, 51 |
| Template send — Graph API endpoint | PASS | Posts to `/{phoneNumberId}/messages` with correct template body structure | meta-adapter/src/index.ts:191, graph-messages.ts:22-46 |
| Template send — accessToken from channel | PASS | accessToken passed from ChannelCredentials through callMetaAdapter to graphRequest | notification-worker/src/index.ts:131-138, meta-adapter/src/index.ts:258 |
| Meta-adapter error handling on 503 | PASS | graphRequest: circuit breaker after 5 failures (30s cooldown), 4 retries with exponential backoff + jitter, Retry-After honoured | meta-adapter/src/index.ts:57-157 |
| Outbox — atomic enqueue | PASS | outboxRepository.enqueue() called inside withTenant (transaction) for both campaign types | api-gateway/src/index.ts:419-434, 497-514 |
| Outbox relay | PASS | startOutboxRelay() polls every 1s, claims up to 50 rows, publishes to eventBus | api-gateway/src/index.ts:698-722 |
| Outbox message shape for CampaignDispatchRequested | PASS | Includes: campaignId, tenantId, channelId, templateName, templateLanguage, templateCategory, contactPhoneE164, parameters | api-gateway/src/index.ts:426-433 |
| Campaign scheduler (scheduledAt) | PASS | startCampaignScheduler polls every 30s, calls filterSendableContacts, atomically claims via SQL, enqueues CampaignRunRequested | api-gateway/src/index.ts:726-792 |
| Idempotent fan-out send (duplicate prevention) | PASS | campaignSendLog.tryClaim() dedupes per (campaign, phone); released on failure for retry | notification-worker/src/index.ts:168-172 |
| UI — syncTemplates API call | PASS | POST /channels/whatsapp/{channelId}/sync-templates (correct) | web-portal/public/index.html:2275 |
| UI — loadTemplates API call | PASS | GET /templates (correct) | web-portal/public/index.html:2175 |
| UI — loadCampaigns API call | PASS | GET /campaigns?offset={n} (correct, paginated) | web-portal/public/index.html:2210 |
| UI — dispatch test send API call | PASS | POST /campaigns/{id}/dispatch with {contactPhoneE164, parameters[]} (correct) | web-portal/public/index.html:2486 |
| UI — run campaign API call | PASS | POST /campaigns/{id}/run with {} (correct) | web-portal/public/index.html:2455 |
| UI — template filter for campaign creation | PARTIAL | UI correctly filters to `marketing` + `approved` templates before showing in modal; server also enforces this | web-portal/public/index.html:2317 |
| Template status filter for dispatch | GAP | GET /templates returns all statuses; no server-side approved-only filtering when listing for dispatch selection | api-gateway/src/index.ts:1404-1407 |
| Approved check on run | PASS | runCampaign() returns 422 if `template.status !== "approved"` | api-gateway/src/index.ts:453-455 |

---

## Issues (GAP / PARTIAL / BUG only)

### Campaign Recipients — GAP

**File:** `services/api-gateway/src/index.ts:2014-2031`

**Detail:** There is no standalone `GET /campaigns/:id/recipients` route. Recipient data is only accessible via `GET /campaigns/:id/report`, which caps the response at 500 rows (`listByCampaign(tenantId, campaignId, { limit: 500 })`). For large campaigns (>500 recipients), operators cannot paginate through the full recipient list.

**Impact:** No paginated recipient browser for large campaigns. Compliance/audit use cases that need full per-recipient status lists are blocked above 500 contacts.

---

### contactIds Not Accepted in Campaign Creation — PARTIAL

**File:** `services/api-gateway/src/index.ts:1877-1940`

**Detail:** The audit task specification asks to verify that `segmentId or contactIds` are accepted. Only `segmentId` is supported. The `CreateCampaignRequest` interface has no `contactIds` field, and `runCampaign()` requires `campaign.segmentId` or returns 422. There is no ad-hoc phone list targeting path.

**Impact:** Operators cannot create a campaign targeting a manual list of specific contact IDs without first creating a segment. This is a feature gap (not a bug — the system behaves consistently), but worth tracking as a capability limitation.

---

### List Templates — No Server-Side Approved-Only Filter — PARTIAL

**File:** `services/api-gateway/src/index.ts:1404-1407`

**Detail:** `GET /templates` returns all templates regardless of status (approved, pending, rejected, paused). The UI applies a client-side filter (`t.category === "marketing" && t.status === "approved"`) when building the campaign creation dropdown, and the server enforces `template.status === "approved"` at run time. However, the raw list endpoint itself exposes all statuses to any authenticated caller.

**Impact:** Low risk — the server-side approved check at `runCampaign()` and policy engine provide the real safety gate. However, callers who build their own dispatch flows using only the listing API may inadvertently attempt to run campaigns on non-approved templates without clear pre-flight feedback.

---

### Automation Template Category Hardcoded to "marketing" — PARTIAL

**File:** `services/notification-worker/src/index.ts:703`

**Detail:** In `handleAutomationTemplate()`, the message is persisted with `category: "marketing" as MessageCategory`. However, there is no policy check before sending — no consent check, no opted-out check, no quiet hours evaluation — unlike the campaign dispatch path which calls `evaluateOutboundPolicy()`. Automation template sends go directly to `callMetaAdapter` without any policy gate.

**Impact:** Automation-triggered template sends can be dispatched to opted-out contacts or during quiet hours, bypassing all policy engine rules. This is a compliance risk for MARKETING category sends.

---

### Worker 503 from Meta-Adapter Causes Retry but No Explicit 503-to-DLQ Back-Pressure — PARTIAL

**File:** `services/notification-worker/src/index.ts:200-218`, `packages/event-bus/src/index.ts:166-168`

**Detail:** When `callMetaAdapter` throws (network failure or circuit open), `handleDispatch` re-throws, causing the event bus to nack. On first delivery: requeued. On redelivery: DLQ. There is only one retry before DLQ. For transient 503s from a recovering meta-adapter, a single requeue cycle may not be sufficient recovery time — messages can flow to DLQ before the meta-adapter comes back.

**Impact:** During meta-adapter downtime, campaign messages may land in DLQ after a single requeue rather than waiting for recovery. Manual DLQ replay would be required. The meta-adapter's own 4-attempt internal backoff mitigates this somewhat.
