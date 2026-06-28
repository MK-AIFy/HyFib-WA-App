-- Automation no_reply de-dupe marker + task reminder dispatch marker.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS no_reply_fired_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_due_reminders
  ON tasks(remind_at)
  WHERE status = 'open' AND remind_at IS NOT NULL AND reminded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_no_reply
  ON conversations(tenant_id, state, last_inbound_at);
