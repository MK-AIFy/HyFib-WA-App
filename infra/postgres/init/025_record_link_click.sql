-- 025_record_link_click.sql: fix — the public /r/:token redirect could never
-- record a click. link_clicks is FORCE ROW LEVEL SECURITY and
-- linkClickRepository.recordClick ran a bare (tenant-less) UPDATE, so the
-- policy matched zero rows: no click was counted and, worse, the route
-- treated the empty result as an unknown token and answered 404 — every
-- tracked campaign shortlink was dead for recipients.
--
-- The redirect is unauthenticated by design and inherently cross-tenant (the
-- recipient clicking is not a platform user; the 22-char random token is the
-- capability). A narrow SECURITY DEFINER function is the established pattern
-- for exactly this (find_user_by_email_for_auth, resolve_channel_by_phone_number_id).

CREATE OR REPLACE FUNCTION record_link_click(p_token TEXT)
RETURNS TABLE (
  destination TEXT,
  tenant_id   UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE link_clicks
     SET clicked_count    = clicked_count + 1,
         first_clicked_at = COALESCE(first_clicked_at, now()),
         last_clicked_at  = now()
   WHERE token = p_token
  RETURNING link_clicks.destination, link_clicks.tenant_id;
$$;

-- Grant execute to the app role
GRANT EXECUTE ON FUNCTION record_link_click(TEXT) TO hyfib_app;
