-- 026_automation_settings.sql — default automations (roadmap G8): working
-- hours, welcome message, out-of-office reply. One row per tenant.
-- working_hours is the shared-core WorkingHours weekly map; '{}' means the
-- feature is unused (always open), so ooo_enabled alone never fires.
CREATE TABLE IF NOT EXISTS automation_settings (
  tenant_id          UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  timezone           TEXT        NOT NULL DEFAULT 'UTC',
  working_hours      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  welcome_enabled    BOOLEAN     NOT NULL DEFAULT false,
  welcome_text       TEXT,
  ooo_enabled        BOOLEAN     NOT NULL DEFAULT false,
  ooo_text           TEXT,
  -- Repeated OOO replies to the same conversation are suppressed for this long.
  ooo_suppress_hours INT         NOT NULL DEFAULT 12 CHECK (ooo_suppress_hours BETWEEN 1 AND 168),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_settings_tenant_isolation ON automation_settings;
CREATE POLICY automation_settings_tenant_isolation ON automation_settings
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_settings TO hyfib_app;
