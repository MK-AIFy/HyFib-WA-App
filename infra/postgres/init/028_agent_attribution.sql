-- 028_agent_attribution.sql — agent performance reporting (roadmap G11).
-- Outbound conversation sends have carried the acting agent as
-- payload->>'actorId' since the send-types work; that JSONB field is not
-- queryable at aggregation speed, so it is promoted to a real indexed column
-- (and backfilled), and conversations record when/by whom they were closed.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill from the JSONB payload; the regex guard skips non-UUID actor ids
-- (dev-subject fallbacks). Orphaned user ids would break the FK, so only
-- actors that still exist are promoted.
UPDATE messages m
   SET sender_user_id = (m.payload->>'actorId')::uuid
 WHERE m.sender_user_id IS NULL
   AND m.direction = 'outbound'
   AND m.payload->>'actorId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = (m.payload->>'actorId')::uuid);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages (sender_user_id, created_at)
  WHERE sender_user_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
