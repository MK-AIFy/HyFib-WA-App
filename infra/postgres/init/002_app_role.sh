#!/bin/sh
# Creates a dedicated, NON-superuser application role. The platform connects
# as this role so that the row-level-security policies defined in
# 001_schema.sql are enforced (superusers and table owners bypass RLS).
#
# Runs once, during first cluster initialisation, via the Postgres
# docker-entrypoint-initdb.d hook.
set -eu

APP_DB_USER="${APP_DB_USER:-hyfib_app}"

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "FATAL: APP_DB_PASSWORD is not set; refusing to create the app role without a password." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --set=app_user="$APP_DB_USER" \
     --set=app_password="$APP_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec
EOSQL

# Grant CONNECT on the actual database (name comes from POSTGRES_DB) plus
# table/sequence privileges. Done in a second call so we can reference
# POSTGRES_DB safely.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --set=app_user="$APP_DB_USER" <<EOSQL
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL

echo "Application role '$APP_DB_USER' created and granted."
