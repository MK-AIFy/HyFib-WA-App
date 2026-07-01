-- 013_auth.sql: Add authentication, sessions, user limits, tenant slugs
-- Applied at runtime (not on volume re-creation only) — safe to run multiple times.

-- ─── Tenants: add slug (human-readable org ID) and user limits ────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS slug         TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS max_users    INT  DEFAULT 10,
  ADD COLUMN IF NOT EXISTS plan         TEXT DEFAULT 'trial' CHECK (plan IN ('trial','starter','growth','enterprise'));

-- Generate slug from name for existing tenants (lowercase alphanum + hyphens)
UPDATE tenants
SET slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'), '^-|-$', '', 'g')) || '-' || LEFT(id::text, 4)
WHERE slug IS NULL;

-- ─── Users: add password hash and roles array ─────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS roles         TEXT[] DEFAULT '{}';

-- Populate roles from existing status field if present
-- (roles were previously stored implicitly via RBAC headers)

-- ─── Sessions table (token-based auth) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- Allow the app role to manage sessions (sessions are not tenant-scoped via RLS)
GRANT SELECT, INSERT, DELETE ON sessions TO hyfib_app;

-- ─── Seed: reserve the platform tenant (no tenant scope) ──────────────────────
-- This is a stable anchor tenant for platform-level (non-customer) users.
-- No admin user is seeded here — a fixed password hash must never live in
-- version control. The platform owner account is bootstrapped at application
-- startup from BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD env vars
-- (see services/api-gateway/src/index.ts bootstrapPlatformAdmin()), which
-- hashes the password with the app's own scrypt implementation so the format
-- always matches what verifyPassword() expects.
INSERT INTO tenants (id, name, slug, status, plan, max_users)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'HyFib Platform',
  'hyfib-platform',
  'active',
  'enterprise',
  9999
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;
