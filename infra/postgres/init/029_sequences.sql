-- 029_sequences.sql — drip sequences (roadmap G7). A sequence is an ordered
-- list of template steps with per-step delays; contacts are enrolled (usually
-- from a segment) and advance step by step via the gateway scheduler. An
-- inbound reply stops enrollments in sequences with stop_on_reply (the WATI
-- semantic: a human conversation supersedes the drip).
CREATE TABLE IF NOT EXISTS sequences (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES whatsapp_channels(id),
  -- draft | active | paused
  status        TEXT        NOT NULL DEFAULT 'draft',
  stop_on_reply BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id   UUID        NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order    INT         NOT NULL CHECK (step_order >= 1),
  -- Delay from enrollment (step 1) or from the previous step's send.
  delay_minutes INT         NOT NULL CHECK (delay_minutes BETWEEN 0 AND 525600),
  template_id   UUID        NOT NULL REFERENCES templates(id),
  UNIQUE (tenant_id, sequence_id, step_order)
);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id    UUID        NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id     UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- active | completed | stopped
  status         TEXT        NOT NULL DEFAULT 'active',
  -- Steps already sent; the next due step is current_step + 1.
  current_step   INT         NOT NULL DEFAULT 0,
  next_step_at   TIMESTAMPTZ,
  stopped_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sequence_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments (next_step_at)
  WHERE status = 'active';

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sequences_tenant_isolation ON sequences;
CREATE POLICY sequences_tenant_isolation ON sequences
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sequence_steps_tenant_isolation ON sequence_steps;
CREATE POLICY sequence_steps_tenant_isolation ON sequence_steps
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sequence_enrollments_tenant_isolation ON sequence_enrollments;
CREATE POLICY sequence_enrollments_tenant_isolation ON sequence_enrollments
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON sequences, sequence_steps, sequence_enrollments TO hyfib_app;

-- Cross-tenant due scan for the gateway scheduler (011 pattern): only ids +
-- tenant ids leak; all processing happens tenant-scoped afterwards.
CREATE OR REPLACE FUNCTION due_sequence_enrollments(p_limit INT)
RETURNS TABLE (id UUID, tenant_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.tenant_id
  FROM sequence_enrollments e
  JOIN sequences s ON s.id = e.sequence_id
  WHERE e.status = 'active'
    AND e.next_step_at IS NOT NULL
    AND e.next_step_at <= now()
    AND s.status = 'active'
  ORDER BY e.next_step_at
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION due_sequence_enrollments(INT) TO hyfib_app;
