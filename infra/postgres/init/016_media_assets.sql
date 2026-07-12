-- Media storage foundations: a FORCE-RLS table to hold fetched inbound
-- media bytes (image/video/audio/document) alongside their Meta media id
-- and fetch status. Today notification-worker only persists media metadata
-- inside messages.payload JSONB and never downloads the bytes; this table
-- is the storage substrate for the fetch pipeline added in a later task
-- (meta-adapter Graph fetch + worker consumer + gateway serve route).
--
-- No GRANT needed here: 002_app_role.sh's `ALTER DEFAULT PRIVILEGES ... GRANT
-- SELECT, INSERT, UPDATE, DELETE ON TABLES TO hyfib_app` already covers any
-- table created after role bootstrap, including this one.

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meta_media_id TEXT NOT NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  mime_type TEXT,
  filename TEXT,
  sha256 TEXT,
  file_size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | stored | failed
  error TEXT,
  bytes BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at TIMESTAMPTZ,
  UNIQUE (tenant_id, meta_media_id)
);
CREATE INDEX IF NOT EXISTS idx_media_assets_message ON media_assets(tenant_id, message_id);
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_assets_tenant_isolation ON media_assets;
CREATE POLICY media_assets_tenant_isolation ON media_assets
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
