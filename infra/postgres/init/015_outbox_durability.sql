-- Outbox durability: bounded retries with exponential backoff and a dead
-- state, so a poison row (e.g. a handler that always throws) stops retrying
-- forever and no longer blocks the rest of the batch. The relay/gateway
-- change that actually calls outbox_mark_failed on dispatch errors is a
-- separate follow-up task; this migration only adds the DB substrate.
--
-- `status` on outbox_events is plain TEXT with no CHECK constraint (see
-- 001_schema.sql), so no constraint needs to be extended to allow 'dead'.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_pending_next ON outbox_events(next_attempt_at) WHERE status = 'pending';

-- Re-declares outbox_claim (originally defined in 003_functions.sql) to also
-- respect next_attempt_at, so a backed-off row is not reclaimed before its
-- scheduled retry time. CREATE OR REPLACE preserves the existing GRANT to
-- hyfib_app (see 003_functions.sql) — no re-grant needed.
CREATE OR REPLACE FUNCTION outbox_claim(p_limit INT)
RETURNS SETOF outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbox_events o
  SET status = 'processing', claimed_at = now()
  WHERE o.id IN (
    SELECT e.id FROM outbox_events e
    WHERE (e.status = 'pending' AND e.next_attempt_at <= now())
       OR (e.status = 'processing' AND e.claimed_at < now() - INTERVAL '2 minutes')
    ORDER BY e.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING o.*;
END;
$$;

-- Records a failed dispatch attempt: increments attempts, stores the error
-- (truncated to avoid unbounded row growth), and either schedules the next
-- retry with capped exponential backoff or marks the row 'dead' once
-- p_max_attempts is reached.
CREATE OR REPLACE FUNCTION outbox_mark_failed(p_id UUID, p_error TEXT, p_max_attempts INT DEFAULT 8)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE outbox_events SET
    attempts = attempts + 1,
    last_error = left(p_error, 2000),
    status = CASE WHEN attempts + 1 >= p_max_attempts THEN 'dead' ELSE 'pending' END,
    next_attempt_at = now() + LEAST(INTERVAL '30 seconds' * POWER(2, attempts), INTERVAL '15 minutes')
  WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION outbox_mark_failed(UUID, TEXT, INT) TO hyfib_app;
