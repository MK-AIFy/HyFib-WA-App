-- 027_round_robin.sql — round-robin auto-assignment (roadmap G9). Rotation is
-- scoped to one team's active members; the cursor (last assigned user) lives
-- on automation_settings so the next pick continues after it. Enabled without
-- a team is a no-op, mirroring OOO-without-hours in G8.
ALTER TABLE automation_settings
  ADD COLUMN IF NOT EXISTS round_robin_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS round_robin_team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS round_robin_last_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
