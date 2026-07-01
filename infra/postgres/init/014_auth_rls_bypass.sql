-- 014_auth_rls_bypass.sql: SECURITY DEFINER function for cross-tenant email lookup
-- The users table has RLS that requires app.tenant_id. Authentication is inherently
-- cross-tenant (user supplies email, we need to find which tenant they belong to).
-- This function runs as the 'platform' owner (BYPASSRLS) to do a safe, targeted
-- email lookup that returns only the minimal fields needed for login.

CREATE OR REPLACE FUNCTION find_user_by_email_for_auth(p_email TEXT)
RETURNS TABLE (
  id           UUID,
  tenant_id    UUID,
  email        TEXT,
  display_name TEXT,
  status       TEXT,
  password_hash TEXT,
  roles        TEXT[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id,
    u.tenant_id,
    u.email,
    u.display_name,
    u.status,
    u.password_hash,
    COALESCE(
      ARRAY_AGG(rb.role) FILTER (WHERE rb.role IS NOT NULL),
      u.roles,
      '{}'::TEXT[]
    ) AS roles
  FROM users u
  LEFT JOIN role_bindings rb ON rb.user_id = u.id
  WHERE u.email = p_email
  GROUP BY u.id
  LIMIT 1;
$$;

-- Grant execute to the app role
GRANT EXECUTE ON FUNCTION find_user_by_email_for_auth(TEXT) TO hyfib_app;
