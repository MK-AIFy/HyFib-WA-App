-- Server-side conversation search: contact name/phone fragments via
-- trigram similarity, plus a covering index for per-conversation message
-- thread pagination (pulled forward for the unread-count and thread
-- pagination tasks that follow this one).
--
-- scripts/migrate.sh runs every *.sql file through `psql --username
-- "$PGUSER"` where PGUSER is $POSTGRES_USER (the platform/superuser-ish
-- role provisioned for the Postgres container), not the low-privilege
-- hyfib_app role — so CREATE EXTENSION is permitted here.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON contacts USING gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm
  ON contacts USING gin (phone_e164 gin_trgm_ops);

-- Pulled forward: unread counting (next task) and thread pagination both need this.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);
