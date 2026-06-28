-- Phase 1 CRM foundation: team model, tags/notes, and tenant WhatsApp settings.

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, team_id, user_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS contact_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_verify_token_encrypted TEXT,
  app_secret_encrypted TEXT,
  status_callback_url TEXT,
  graph_version TEXT NOT NULL DEFAULT 'v22.0',
  retry_max_attempts INT NOT NULL DEFAULT 4,
  retry_base_delay_ms INT NOT NULL DEFAULT 500,
  outbound_rate_limit_per_minute INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rbac_role_bundles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  roles TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_tenant_team ON team_members(tenant_id, team_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tenant_contact ON contact_tags(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_notes_tenant_contact_created ON contact_notes(tenant_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_tenant_conv_created ON conversation_notes(tenant_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action_created ON audit_events(tenant_id, action, created_at DESC);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_tenant_isolation ON teams;
CREATE POLICY teams_tenant_isolation ON teams
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_tenant_isolation ON team_members;
CREATE POLICY team_members_tenant_isolation ON team_members
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_tenant_isolation ON tags;
CREATE POLICY tags_tenant_isolation ON tags
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_tags_tenant_isolation ON contact_tags;
CREATE POLICY contact_tags_tenant_isolation ON contact_tags
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_notes_tenant_isolation ON contact_notes;
CREATE POLICY contact_notes_tenant_isolation ON contact_notes
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_notes_tenant_isolation ON conversation_notes;
CREATE POLICY conversation_notes_tenant_isolation ON conversation_notes
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_settings_tenant_isolation ON whatsapp_settings;
CREATE POLICY whatsapp_settings_tenant_isolation ON whatsapp_settings
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
