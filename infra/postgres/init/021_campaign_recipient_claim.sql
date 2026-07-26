-- Campaign fan-out convergence: campaign_recipients needs a claim marker.
--
-- claimPendingBatch was a bare SELECT whose FOR UPDATE SKIP LOCKED locks were
-- released by the enclosing withTenant COMMIT before the caller used a row,
-- and the fan-out loop in notification-worker never marks approved recipients
-- off 'pending' (they leave it only in handleDispatch). Every iteration
-- therefore re-selected the same rows and the loop could not converge.
--
-- claimed_at is stamped by the claim itself, mirroring outbox_claim in
-- 015_outbox_durability.sql. A row whose claim is older than the caller's
-- stale window is reclaimable, so a process that dies between claiming and
-- enqueueing does not strand recipients.
--
-- `status` on campaign_recipients is plain TEXT with no CHECK constraint (see
-- 006_marketing.sql), and this migration adds no status values in any case.

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Serves the claim's `campaign_id = $1 AND status = 'pending'` filter and its
-- `ORDER BY created_at`. The existing idx_campaign_recipients_campaign_status
-- stays; it serves the funnel-count queries.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_claim
  ON campaign_recipients(campaign_id, created_at) WHERE status = 'pending';
