-- Two hot-path indexes that were missing, and a lockdown of EXECUTE on the
-- SECURITY DEFINER functions.
--
-- ─── 1. Indexes ─────────────────────────────────────────────────────────────
--
-- Both of these back queries that run on EVERY inbound WhatsApp message, and
-- neither had an index to use:
--
--   * messageRepository.findByExternalId — `SELECT ... FROM messages WHERE
--     external_message_id = $1` — is the inbound replay guard. `messages` is
--     the largest table in the system and `external_message_id` was unindexed
--     (only campaign_recipients.external_message_id has one, from 006), so
--     every inbound webhook paid a sequential scan that grows without bound.
--
--   * sequenceRepository.stopActiveForContact — filters
--     (tenant_id, contact_id, status = 'active') — is stop-on-reply. The only
--     index on sequence_enrollments is idx_sequence_enrollments_due
--     (next_step_at), and the UNIQUE (tenant_id, sequence_id, contact_id)
--     constraint cannot serve it: contact_id is not a usable prefix once
--     sequence_id is skipped.
--
-- Both are partial. `external_message_id` is NULL on outbound rows until the
-- send is acknowledged, and the planner can prove `= $1` implies NOT NULL, so
-- the partial index is both usable and smaller. Likewise only 'active'
-- enrollments are ever stopped, and they are a small slice of the table.
--
-- Locking note: CREATE INDEX CONCURRENTLY does not take the SHARE lock that
-- blocks writes for the whole build, which matters on `messages`. It is safe
-- here — scripts/migrate.sh applies each file as a single `psql -f` with no
-- explicit BEGIN, so statements autocommit individually, and CONCURRENTLY
-- cannot run inside a transaction block. This deliberately differs from the
-- plain CREATE INDEX in 020_message_search.sql, whose own note anticipated
-- exactly this once `messages` grew.
--
-- The trap CONCURRENTLY brings is that a failed build leaves an INVALID index
-- behind, and `IF NOT EXISTS` would then skip it forever on a re-run, silently
-- leaving the table unindexed. The DO block below drops any invalid leftover
-- first, so re-running this migration after a failure actually rebuilds.

DO $$
DECLARE
  invalid_index TEXT;
BEGIN
  FOR invalid_index IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT i.indisvalid
      AND c.relname IN ('idx_messages_external_message_id', 'idx_sequence_enrollments_contact_active')
  LOOP
    RAISE NOTICE 'Dropping invalid index % left by a failed CREATE INDEX CONCURRENTLY', invalid_index;
    EXECUTE format('DROP INDEX IF EXISTS public.%I', invalid_index);
  END LOOP;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_external_message_id
  ON messages (external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sequence_enrollments_contact_active
  ON sequence_enrollments (tenant_id, contact_id)
  WHERE status = 'active';

-- ─── 2. EXECUTE on the SECURITY DEFINER functions ───────────────────────────
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Every
-- function below is SECURITY DEFINER and is owned by the bootstrap superuser
-- that runs these init scripts, so each one runs with superuser rights and
-- bypasses row-level security by design. Leaving them executable by PUBLIC
-- means any role that can merely connect — a future reporting or read-only
-- user, a BI tool, an operator account — inherits the ability to call them.
-- find_user_by_email_for_auth returns the stored password hash; record_link_click
-- and the outbox_* functions mutate. The application role hyfib_app holds an
-- explicit GRANT for all twelve, so revoking PUBLIC changes nothing for it.
--
-- This is defense in depth: today only hyfib_app and the owner exist, so
-- nothing is currently exploiting it. The point is that the next role added to
-- this database should not silently inherit superuser-backed entry points.
--
-- Idempotent: REVOKE of a privilege that is not held is a no-op, and the
-- GRANTs are re-asserted so the intended state holds however this file is
-- reached (fresh initdb or scripts/migrate.sh against an existing volume).

REVOKE EXECUTE ON FUNCTION resolve_channel_by_phone_number_id(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION outbox_claim(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION outbox_mark_processed(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION outbox_mark_failed(UUID, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_campaign_recipient_by_ext_id(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION due_scheduled_campaigns(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION due_no_reply_conversations(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION due_task_reminders(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION due_sequence_enrollments(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_drained_campaigns(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION find_user_by_email_for_auth(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_link_click(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_channel_by_phone_number_id(TEXT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION outbox_claim(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION outbox_mark_processed(UUID) TO hyfib_app;
GRANT EXECUTE ON FUNCTION outbox_mark_failed(UUID, TEXT, INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION get_campaign_recipient_by_ext_id(TEXT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_scheduled_campaigns(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_no_reply_conversations(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_task_reminders(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION due_sequence_enrollments(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION complete_drained_campaigns(INT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION find_user_by_email_for_auth(TEXT) TO hyfib_app;
GRANT EXECUTE ON FUNCTION record_link_click(TEXT) TO hyfib_app;

-- Root cause, not just today's twelve: stop the default from applying to
-- functions this role creates in public from here on, so a future migration
-- that adds a SECURITY DEFINER function does not reopen the same hole by
-- omission. Only affects objects created by the role that runs the migrations,
-- which is the role that owns every function above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
