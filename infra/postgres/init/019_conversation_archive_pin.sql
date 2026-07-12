-- Archive and pin state for conversations. Both are nullable timestamps
-- (rather than booleans) so they double as an audit trail ("when was this
-- archived/pinned") for free. Archive is ORTHOGONAL to the existing `state`
-- (open/pending/closed) column — it is not a fourth state, just an inbox
-- visibility flag layered on top. No index — single-org conversation counts
-- are small.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_at   TIMESTAMPTZ;
