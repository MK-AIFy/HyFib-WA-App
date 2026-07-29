-- 031_flows.sql — chatbot flows (roadmap G14). The definition is the JSON
-- graph the (future) visual builder edits; the worker executes it reactively
-- on inbound messages. One ACTIVE session per conversation (partial unique):
-- a customer is in at most one bot flow at a time.
CREATE TABLE IF NOT EXISTS flows (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  -- draft | active | paused
  status          TEXT        NOT NULL DEFAULT 'draft',
  -- Inbound text that starts the flow (case-insensitive exact match);
  -- NULL = only started via the API.
  trigger_keyword TEXT,
  definition      JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_sessions (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id         UUID        NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_node    TEXT        NOT NULL,
  -- active | completed | cancelled
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_sessions_one_active
  ON flow_sessions (tenant_id, conversation_id)
  WHERE status = 'active';

ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flows_tenant_isolation ON flows;
CREATE POLICY flows_tenant_isolation ON flows
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE flow_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_sessions_tenant_isolation ON flow_sessions;
CREATE POLICY flow_sessions_tenant_isolation ON flow_sessions
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON flows, flow_sessions TO hyfib_app;
