-- 030_developer_platform.sql — public API keys + outbound webhook signing
-- (roadmap Phase D). Keys are stored ONLY as sha256 hashes; the prefix is
-- kept for display ("hyfib_ab12cd34…"). Roles bound to the key become the
-- caller's AuthContext roles, so existing per-route RBAC applies unchanged.
CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  key_hash    TEXT        NOT NULL UNIQUE,
  key_prefix  TEXT        NOT NULL,
  roles       TEXT[]      NOT NULL DEFAULT '{}',
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO hyfib_app;

-- Outbound webhooks: requests to status_callback_url are HMAC-signed with
-- this per-tenant secret so receivers can authenticate them.
ALTER TABLE whatsapp_settings
  ADD COLUMN IF NOT EXISTS status_callback_secret TEXT;
