-- Phase 5 automation rules + tasks/reminders.

CREATE TABLE IF NOT EXISTS automation_rules (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  -- new_message / tag_added / conversation_assigned / no_reply
  trigger_type  TEXT        NOT NULL,
  -- JSON: { keyword?, tag?, delayMinutes? }
  conditions    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- send_template / assign_agent / add_tag / create_task
  action_type   TEXT        NOT NULL,
  -- JSON: { templateName?, templateLanguage?, assigneeUserId?, tag?, taskTitle?, dueInMinutes? }
  action_config JSONB       NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  priority      INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger
  ON automation_rules(tenant_id, trigger_type, enabled);

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_rules_tenant_isolation ON automation_rules;
CREATE POLICY automation_rules_tenant_isolation ON automation_rules
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS tasks (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  -- open / done / cancelled
  status           TEXT        NOT NULL DEFAULT 'open',
  contact_id       UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id  UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  assignee_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  due_at           TIMESTAMPTZ,
  remind_at        TIMESTAMPTZ,
  source           TEXT        NOT NULL DEFAULT 'manual',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status_due
  ON tasks(tenant_id, status, due_at);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_tenant_isolation ON tasks;
CREATE POLICY tasks_tenant_isolation ON tasks
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
