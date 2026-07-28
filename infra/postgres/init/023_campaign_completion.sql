-- Campaign completion sweep.
--
-- The fan-out loop used to write 'completed' when claimPendingBatch returned an
-- empty batch. That criterion is wrong: the claim excludes rows it has already
-- stamped with claimed_at (021), so an empty batch means "nothing unclaimed
-- right now", not "finished". The recipients claimed on the previous iteration
-- are still 'pending' with their dispatch rows sitting in the outbox — so a run
-- marked itself completed while its own sends were still queued, and the
-- dispatch-time status guard then correctly refused to send them.
--
-- A recipient leaves 'pending' only when handleDispatch resolves it, when
-- duplicate suppression retires it, or when a cancel retires it. So the true
-- drained condition is: the campaign has recipients, and none are pending.
--
-- The fan-out cannot observe that itself. Under the in-memory bus it enqueues
-- dispatch rows and returns before the relay publishes them, so at loop exit
-- there are always pending recipients. Completion must be observed after the
-- sends resolve, which is what this sweep does.
--
-- SECURITY DEFINER for the same reason as due_scheduled_campaigns in
-- 011_scheduler_functions.sql: the sweep is cross-tenant and campaigns is under
-- FORCE ROW LEVEL SECURITY with no app.tenant_id set in a scheduler context.
-- It exposes a narrow write and returns only ids.

CREATE OR REPLACE FUNCTION complete_drained_campaigns(p_limit INT)
RETURNS TABLE (id UUID, tenant_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH drained AS MATERIALIZED (
    SELECT c.id FROM campaigns c
    WHERE c.status = 'running'
      -- A single-number test send promotes a draft campaign to 'running'
      -- without creating recipients. Without this it would complete instantly.
      AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id)
      -- The actual fix: an in-flight run always has pending recipients, whether
      -- or not they are claimed, so it can never be completed early.
      AND NOT EXISTS (
        SELECT 1 FROM campaign_recipients r
        WHERE r.campaign_id = c.id AND r.status = 'pending'
      )
    ORDER BY c.created_at
    LIMIT p_limit
  )
  UPDATE campaigns c SET status = 'completed'
  FROM drained
  -- Re-checking 'running' makes this a compare-and-swap: an operator pause
  -- landing between the CTE and the update must win. The sweep losing is the
  -- correct outcome, not an error.
  WHERE c.id = drained.id AND c.status = 'running'
  RETURNING c.id, c.tenant_id;
$$;

GRANT EXECUTE ON FUNCTION complete_drained_campaigns(INT) TO hyfib_app;
