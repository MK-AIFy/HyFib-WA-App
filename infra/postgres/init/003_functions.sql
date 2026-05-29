-- Event-driven message lifecycle support: a transactional-outbox relay claim
-- mechanism and a tenant-resolution function used by system consumers that
-- process inbound webhooks without a tenant context.

-- Outbox relay bookkeeping: who claimed a row and when (for crash recovery).
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Exactly-once-ish dispatch guard so a redelivered campaign event cannot send
-- the same template to the same contact twice. Tenant-scoped under RLS.
CREATE TABLE IF NOT EXISTS campaign_send_log (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL,
  phone_e164 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, campaign_id, phone_e164)
);

ALTER TABLE campaign_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_log FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_send_log_tenant_isolation ON campaign_send_log
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- Maps a Meta phone_number_id to its owning tenant + channel. SECURITY DEFINER
-- so the system consumer can resolve routing without a tenant context; it only
-- exposes the single lookup, never bypasses RLS for general reads.
CREATE OR REPLACE FUNCTION resolve_channel_by_phone_number_id(p_phone_number_id TEXT)
RETURNS TABLE (tenant_id UUID, channel_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id AS channel_id
  FROM whatsapp_channels
  WHERE phone_number_id = p_phone_number_id
  ORDER BY created_at ASC
  LIMIT 1;
$$;

-- Atomically claims pending outbox rows (and reclaims rows stuck in 'processing'
-- for more than 2 minutes after a crashed relay). SKIP LOCKED allows multiple
-- relay instances to run concurrently.
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
    WHERE e.status = 'pending'
       OR (e.status = 'processing' AND e.claimed_at < now() - INTERVAL '2 minutes')
    ORDER BY e.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION outbox_mark_processed(p_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE outbox_events SET status = 'processed', processed_at = now() WHERE id = p_id;
$$;

-- The application role may execute the helpers but does not own the tables.
GRANT EXECUTE ON FUNCTION resolve_channel_by_phone_number_id(TEXT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION outbox_claim(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION outbox_mark_processed(UUID) TO hyfib_app;
