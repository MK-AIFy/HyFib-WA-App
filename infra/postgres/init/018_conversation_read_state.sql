-- Per-conversation read watermark for computed unread counts. Nullable,
-- no default (never-read conversations have last_read_at = NULL and the
-- unread subquery treats that as -infinity), no index — the watermark is
-- only ever read via the per-row correlated subquery in CONV_SELECT, which
-- rides idx_messages_conversation_created (migration 017).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
