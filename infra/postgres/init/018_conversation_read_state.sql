-- Per-conversation read watermark for computed unread counts. Nullable,
-- no default (never-read conversations have last_read_at = NULL and the
-- unread subquery treats that as -infinity), no index — the watermark is
-- only ever read via the per-row correlated subquery in CONV_SELECT, which
-- rides idx_messages_conversation_created — created in migration 005 with
-- (conversation_id, created_at) ASC; migration 017's same-name DESC CREATE
-- INDEX IF NOT EXISTS is a no-op against it, so the live index is the 005
-- ASC one.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
