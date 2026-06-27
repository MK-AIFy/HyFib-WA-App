-- Marketing engine: audience segments, bulk import, campaign fan-out, auto-reply, inbox routing.

-- ─── Segments ──────────────────────────────────────────────────────────────────
-- Reusable audience definitions; resolved at campaign run time.
CREATE TABLE IF NOT EXISTS segments (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  -- JSON: { tags?: string[], country?: string, hasConsent?: bool, optedInOnly?: bool }
  definition  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
CREATE POLICY segments_tenant_isolation ON segments
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- ─── Contact imports ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_imports (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename      TEXT,
  total         INT         NOT NULL DEFAULT 0,
  created_count INT         NOT NULL DEFAULT 0,
  updated_count INT         NOT NULL DEFAULT 0,
  skipped_count INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contact_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_imports_tenant_isolation ON contact_imports
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- ─── Campaign recipients (per-contact funnel) ──────────────────────────────────
-- Materialised at dispatch time; drives the delivery funnel.
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id         UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id          UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone_e164          TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending',
  -- pending / policy_skipped / sent / delivered / read / failed
  external_message_id TEXT,
  error               TEXT,
  skip_reason         TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status
  ON campaign_recipients(tenant_id, campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_ext_msg
  ON campaign_recipients(external_message_id);

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_recipients_tenant_isolation ON campaign_recipients
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- ─── Extend campaigns ──────────────────────────────────────────────────────────
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS segment_id UUID REFERENCES segments(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
-- JSON: { "1": "firstName", "2": { "literal": "20% off" } }
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS variable_mapping JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS rate_per_minute INT;

-- ─── Extend contacts ──────────────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone TEXT;

-- ─── Extend conversations ─────────────────────────────────────────────────────
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'open';
-- open / pending / closed

-- ─── Auto-reply rules ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_reply_rules (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- keyword / contains / regex / any
  match_type  TEXT        NOT NULL DEFAULT 'keyword',
  keyword     TEXT,
  reply_kind  TEXT        NOT NULL DEFAULT 'text',
  reply_text  TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  priority    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE auto_reply_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_reply_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY auto_reply_rules_tenant_isolation ON auto_reply_rules
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- ─── Click tracking ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_clicks (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token         TEXT        NOT NULL UNIQUE,
  destination   TEXT        NOT NULL,
  campaign_id   UUID        REFERENCES campaigns(id),
  contact_id    UUID        REFERENCES contacts(id),
  clicked_count INT         NOT NULL DEFAULT 0,
  first_clicked_at TIMESTAMPTZ,
  last_clicked_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_clicks FORCE ROW LEVEL SECURITY;
CREATE POLICY link_clicks_tenant_isolation ON link_clicks
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- ─── Campaign stats: add delivered / read counters ────────────────────────────
ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS delivered_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS read_count      BIGINT NOT NULL DEFAULT 0;

-- ─── Function: resolve campaign recipients by external message id ──────────────
CREATE OR REPLACE FUNCTION get_campaign_recipient_by_ext_id(p_external_message_id TEXT)
RETURNS TABLE (tenant_id UUID, campaign_id UUID, recipient_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, campaign_id, id AS recipient_id
  FROM campaign_recipients
  WHERE external_message_id = p_external_message_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_campaign_recipient_by_ext_id(TEXT) TO hyfib_app;
