# Campaign Completion Sweeper — Design

**Date:** 2026-07-26
**Status:** approved
**Scope:** `infra/postgres/init`, `services/notification-worker`, `services/api-gateway`
**Supersedes:** the completion half of `2026-07-26-campaign-pause-resume-design.md` §7
(A2b's "drained run writes completed")

---

## 1. The defect this fixes

A2b made `handleCampaignRun` write `completed` when `claimPendingBatch` returned
an empty batch. That criterion is wrong.

`claimPendingBatch` excludes rows it has already stamped with `claimed_at`
(migration `021`). An empty batch therefore means **"nothing unclaimed right
now"**, not "the campaign is finished". The recipients claimed on the previous
iteration are still `pending` — their dispatch rows are sitting in the outbox,
not yet sent.

So a run marks itself `completed` while its own sends are still queued.

Observed live, timestamps from a real run:

```
09:04:30.066  campaign_run_started
09:04:30.130  campaign_run_completed  processed:2  exitReason:"drained"
09:04:30.132  dispatch_skipped_campaign_not_running  status:"completed"
09:04:31.074  dispatch_skipped_campaign_not_running  status:"completed"
```

The run completed itself, then the status guard correctly refused to send for a
completed campaign. **Both recipients were left `pending` and nothing was ever
sent.**

### Severity depends on whether the status guard is present

- **Without the guard (main today):** cosmetic. Dispatches still send; the
  status is merely wrong and early.
- **With the guard:** total send failure. The guard behaves exactly as
  specified; its input is wrong.

The guard therefore cannot ship until completion is correct. Both land together.

## 2. The correct completion criterion

A recipient leaves `pending` only when `handleDispatch` resolves it to
`sent`/`failed`, when duplicate suppression retires it, or when `cancelPending`
retires it. So the true drained condition is:

> the campaign has recipients, and **none** of them are `pending`.

"Claimed" is irrelevant — a claimed recipient is in flight, not finished.

### Why the fan-out loop cannot be the writer

Under the in-memory bus the fan-out enqueues dispatch rows to the outbox and
returns; the relay publishes them only afterwards. At loop exit there are
therefore *always* pending recipients on a fresh run. A loop that only completed
when pending hit zero would essentially never fire, leaving campaigns at
`running` — the very ambiguity A2b existed to remove.

Completion has to be observed by something that runs *after* the sends resolve.

## 3. Design

### 3.1 Migration `023` — `complete_drained_campaigns`

`SECURITY DEFINER`, because the sweep is cross-tenant and `campaigns` is under
FORCE RLS with no `app.tenant_id` set in a scheduler context. Directly mirrors
`due_scheduled_campaigns` (`infra/postgres/init/011_scheduler_functions.sql:5`),
including the narrow return shape and the `GRANT ... TO hyfib_app`.

```sql
CREATE OR REPLACE FUNCTION complete_drained_campaigns(p_limit INT)
RETURNS TABLE (id UUID, tenant_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH drained AS MATERIALIZED (
    SELECT c.id FROM campaigns c
    WHERE c.status = 'running'
      AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM campaign_recipients r
        WHERE r.campaign_id = c.id AND r.status = 'pending'
      )
    LIMIT p_limit
  )
  UPDATE campaigns c SET status = 'completed'
  FROM drained
  WHERE c.id = drained.id AND c.status = 'running'
  RETURNING c.id, c.tenant_id;
$$;
```

Four things are load-bearing:

- **`EXISTS (recipients)`** stops a campaign with no recipients from being
  completed. The single-number test send promotes a `draft` campaign to
  `running` without creating any recipients; without this it would be completed
  immediately.
- **`NOT EXISTS (pending)`** is the actual fix. An in-flight run always has
  pending recipients, so it cannot be completed early.
- **`AND c.status = 'running'` on the UPDATE** is a compare-and-swap. An
  operator pause landing between the CTE and the update must win; the sweep
  losing is correct, not an error.
- **`MATERIALIZED`** for consistency with `021`/`022`. There is no `SKIP LOCKED`
  here so the subquery is deterministic and the planner hazard those migrations
  document does not apply, but pinning it costs nothing and removes the question.

### 3.2 The worker stops writing `completed`

`handleCampaignRun`'s completion write is removed entirely — the sweeper is the
single writer, so there is no race to reason about. The loop keeps its
`exitReason` tracking purely for logging, which stays useful for distinguishing
a drained exit from a pause or the batch cap.

### 3.3 The gateway sweeps

A new scheduler beside the existing ones in `services/api-gateway/src/index.ts`,
using the same `setInterval` + `running` re-entrancy guard those use. 60s,
matching the other non-urgent schedulers: completion is a reporting state, not
something an operator waits on.

It calls `SELECT * FROM complete_drained_campaigns($1)` through the non-tenant
`query()` helper — the same way `startCampaignScheduler` calls
`due_scheduled_campaigns` — and logs each completion.

## 4. Consequences worth stating

- **Completion is now eventually consistent**, up to 60s behind the last send.
  Acceptable: nothing blocks on it, and `pendingRecipients` in the pause
  response already gives operators a live signal.
- **A campaign whose recipients all end `policy_skipped`** (everyone opted out,
  or the campaign was cancelled) has zero pending and so completes. Correct — it
  is finished, just with nothing sent.
- **A campaign promoted to `running` by a test send with no recipients** never
  completes and sits at `running`. That matches today's behaviour and is not a
  fan-out, so no completion is meaningful.
- **A worker that dies mid-run** leaves claimed-but-pending recipients. The
  sweeper will not complete the campaign, the stale-claim reclaim eventually
  re-dispatches them, and completion follows. The failure mode is delay, not
  loss.

## 5. Testing

| Layer | Where | What |
|---|---|---|
| SQL | `packages/persistence/test/campaigns.integration.test.js` | completes a drained campaign; does **not** complete one with a pending recipient; does not complete one with no recipients; does not complete a paused campaign; respects the limit; returns tenant_id |
| Worker | `services/notification-worker/test/campaign-run-lifecycle.test.js` | a drained run no longer writes `completed` (replaces the A2b assertion) |

The persistence tests need a repository wrapper to call the function; it goes on
`campaignRepository` as `completeDrained(limit)`, mirroring
`outboxRepository.claim`'s non-tenant `query()` shape.

## 6. Validation

```bash
pnpm build && pnpm lint && pnpm format:check && pnpm test
RUN_DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_DB=hyfib_wa \
  POSTGRES_APP_USER=hyfib_app POSTGRES_APP_PASSWORD=hyfib_app \
  pnpm --filter @hyfib/persistence test
```

Plus a live re-run of the scenario in §1: queue dispatches, pause, release them,
confirm they are skipped and recipients stay `pending`; then resume and confirm
the sends actually go out and the campaign completes afterwards.
