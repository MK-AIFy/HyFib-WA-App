# Pause Stops Queued Sends (P2) — Design

**Date:** 2026-07-26
**Status:** approved
**Scope:** `services/notification-worker` only
**Predecessors:** `2026-07-25-campaign-claim-convergence-design.md`,
`2026-07-26-campaign-pause-resume-design.md`

---

## 1. The gap

Pause currently stops the fan-out from *starting* new batches, but every
dispatch already written to the outbox still sends. `handleDispatch`
(`services/notification-worker/src/index.ts:250`) never reads campaign status —
it claims the send log, checks quota, and sends.

So an operator who pauses a campaign mid-run sees sends continue for as long as
the outbox backlog takes to drain. With the fan-out loop paced at
`ratePerMinute`, that backlog is bounded by one batch of 50 today, but the same
gap will matter far more after P1 (scheduled pacing), where the *entire*
campaign is written to the outbox up front as scheduled rows. This fix is a
prerequisite for that work, not just a polish item.

The A2b abort check made pause mean "no new batches are claimed". This makes it
mean "no further fan-out sends leave the system".

## 2. Design

One guard in `handleDispatch`, placed **before** `campaignSendLog.tryClaim`:

```
validate command
if command.recipientId:                    // fan-out sends only
    status = campaignRepository.getStatus(tenantId, campaignId)
    if status !== "running":
        log dispatch_skipped_campaign_not_running
        return                             // no claim, no send, recipient untouched
tryClaim -> quota -> sendTemplate -> updateStatus     (unchanged)
```

### Why the ordering is the crux

`campaignSendLog` (`infra/postgres/init/003_functions.sql:10`) is the
exactly-once guard, and its rows are never deleted on success — only released on
failure. If the status check ran *after* `tryClaim`, a paused campaign would
consume the claim for a message it never sent, and `tryClaim` would then refuse
that recipient forever. Resume would silently skip them.

Checking first means no claim is taken, so the recipient stays fully sendable.

### Why the recipient row is left `pending`

A skipped recipient keeps `status = 'pending'` and its existing `claimed_at`.
After the stale-claim window (migration `021`) it becomes reclaimable, so a
resumed campaign picks it up and dispatches it again. Marking it terminal here
would make pause lossy — the recipient would never be sent even after resume.

This is the opposite of the duplicate-suppression case, where the row *must* be
retired because nothing will ever send it.

### Why test sends are exempt

A dispatch carrying no `recipientId` comes from `POST /campaigns/{id}/dispatch`,
the single-number test send — an explicit, deliberate operator action taken now,
not queued work from a run. The pause/resume design already documented that a
test send still sends against a paused campaign; the A2a guard only removed its
unintended *status* side-effect.

Gating it here would also surprise an operator trying to verify a template on a
campaign they have paused precisely so they can inspect it. Only fan-out traffic
is gated. Recorded as a product judgment, not a technical constraint: if
cancel/pause should block test sends too, that is a one-line change to drop the
`recipientId` condition.

### Why there is no cache

`repositories.ts:2019` caches channel credentials for five minutes, so caching
would have precedent. It is wrong here: any TTL becomes added pause latency, and
a five-minute cache means five more minutes of sends after the operator clicks
stop — which defeats the entire feature.

`getStatus` (added in A2b) is a single-column lookup on the primary key. It is
negligible beside the `SELECT COUNT(*) FROM messages` monthly-quota check
`handleDispatch` already runs on every send
(`billingRepository.getMonthlyOutboundCount`, `repositories.ts:2905`).

### Status values

Only `running` proceeds. `paused`, `cancelled`, `completed`, `draft`,
`scheduled`, and `undefined` (campaign deleted, or another tenant's — RLS makes
those indistinguishable) all skip. Treating anything other than `running` as
"do not send" is deliberately conservative: a status this code does not
recognise should stop sends, not permit them.

## 3. Testing

`services/notification-worker/test/` — fake bus plus monkey-patched persistence
singletons, the technique `replay.test.js` documents. No Postgres or Redis.

| Case | Assertion |
|---|---|
| campaign `paused` | no `tryClaim`, no send, recipient row untouched |
| campaign `cancelled` | same |
| campaign missing (`undefined`) | same |
| campaign `running` | proceeds to `tryClaim` as before |
| no `recipientId` (test send) | `getStatus` never called; send proceeds |

The "recipient row untouched" assertions are what protect resumability — they
fail if someone later "tidies up" by marking the row on the skip path.

## 4. Validation

```bash
pnpm build && pnpm lint && pnpm format:check && pnpm test
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

## 5. Out of scope

1. **Head-of-line blocking (P1).** A long fan-out still stalls the relay; this
   changes nothing about that. Scheduled pacing is the agreed next cycle.
2. **Cancel does not purge outbox rows.** Rows for a cancelled campaign are
   still published and then skipped here, rather than being deleted or deferred.
   Skipping is cheap and correct; purging would mean matching rows by topic and
   payload contents, which is fragile.
3. **The dispatch route audits unconditionally** (`api-gateway/src/index.ts:2799`),
   recording `campaign.dispatch.requested` even for requests the policy engine
   rejected with a 422. Observed during A2a smoke testing. Real, pre-existing,
   and misleading for a compliance review — worth its own fix.
