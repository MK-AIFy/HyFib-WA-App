-- Cross-tenant scheduler helpers. SECURITY DEFINER so the app role (which is
-- under FORCE ROW LEVEL SECURITY) can scan due work across tenants without a
-- per-tenant app.tenant_id context. Each only exposes a narrow due-items read.

CREATE OR REPLACE FUNCTION due_scheduled_campaigns(p_limit INT)
RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  segment_id UUID,
  variable_mapping JSONB,
  quiet_hours JSONB,
  frequency_cap JSONB,
  rate_per_minute INT,
  template_name TEXT,
  template_language TEXT,
  template_category TEXT,
  template_status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.segment_id, c.variable_mapping, c.quiet_hours, c.frequency_cap,
         c.rate_per_minute, t.name, t.language, t.category, t.status
  FROM campaigns c
  JOIN templates t ON t.id = c.template_id
  WHERE c.status = 'scheduled' AND c.scheduled_at <= now()
  ORDER BY c.scheduled_at
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION due_no_reply_conversations(p_limit INT)
RETURNS TABLE (id UUID, tenant_id UUID, contact_id UUID, last_inbound_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.contact_id, c.last_inbound_at
  FROM conversations c
  WHERE c.state = 'open'
    AND c.last_inbound_at IS NOT NULL
    AND (c.last_message_at IS NULL OR c.last_message_at <= c.last_inbound_at)
    AND (c.no_reply_fired_at IS NULL OR c.no_reply_fired_at < c.last_inbound_at)
    AND EXISTS (
      SELECT 1 FROM automation_rules r
      WHERE r.tenant_id = c.tenant_id AND r.trigger_type = 'no_reply' AND r.enabled = true
    )
  ORDER BY c.last_inbound_at
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION due_task_reminders(p_limit INT)
RETURNS TABLE (id UUID, tenant_id UUID, title TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, title FROM tasks
  WHERE status = 'open' AND remind_at IS NOT NULL AND remind_at <= now() AND reminded_at IS NULL
  ORDER BY remind_at
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION due_scheduled_campaigns(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_no_reply_conversations(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_task_reminders(INT) TO hyfib_app;
