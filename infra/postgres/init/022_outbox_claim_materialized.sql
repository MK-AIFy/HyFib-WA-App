-- Defensive hardening (NOT a bug fix): make outbox_claim's LIMIT structural
-- rather than planner-dependent.
--
-- outbox_claim used `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`.
-- That shape does not guarantee the subquery is evaluated once: the planner may
-- turn it into a semi-join with the subquery on the inner side, re-executing the
-- locking subplan per candidate row. Because SKIP LOCKED yields different rows
-- on each execution, every outer row then matches and the limit is silently
-- exceeded — the claim marks more rows 'processing' than the relay publishes in
-- that tick, and those rows wait for the 2-minute stuck-row rule to recover.
--
-- This was observed for real on campaign_recipients, where RLS injects a
-- predicate that pushes the subquery to the inner side of a Nested Loop Semi
-- Join: a LIMIT 4 claim over 10 pending rows updated all 10 (loops=10). See
-- migration 021 and packages/persistence/src/repositories.ts.
--
-- It could NOT be reproduced here. outbox_claim is SECURITY DEFINER and runs as
-- the table owner, so no RLS predicate is ever injected, and the planner
-- materialises the subquery even with enable_indexscan/bitmapscan/hashagg/
-- hashjoin/material/sort/mergejoin all forced off. outbox_claim is therefore
-- believed correct on every plan reachable today. This migration removes the
-- dependence on that planner choice so a future index, statistics, or volume
-- change cannot reintroduce it.
--
-- Behaviour is otherwise identical: same predicate, same ordering, same locking,
-- same return type. CREATE OR REPLACE preserves the existing GRANT to hyfib_app.

CREATE OR REPLACE FUNCTION outbox_claim(p_limit INT)
RETURNS SETOF outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS MATERIALIZED (
    SELECT e.id FROM outbox_events e
    WHERE (e.status = 'pending' AND e.next_attempt_at <= now())
       OR (e.status = 'processing' AND e.claimed_at < now() - INTERVAL '2 minutes')
    ORDER BY e.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE outbox_events o
  SET status = 'processing', claimed_at = now()
  FROM claimed
  WHERE o.id = claimed.id
  RETURNING o.*;
END;
$$;
