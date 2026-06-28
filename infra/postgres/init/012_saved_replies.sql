-- Saved replies (canned responses) for the inbox composer.
CREATE TABLE IF NOT EXISTS saved_replies (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, title)
);

ALTER TABLE saved_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_replies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_replies_tenant_isolation ON saved_replies;
CREATE POLICY saved_replies_tenant_isolation ON saved_replies
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
