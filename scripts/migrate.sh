#!/usr/bin/env bash
# Applies pending files from infra/postgres/init/ to an existing database.
#
# Postgres only runs docker-entrypoint-initdb.d scripts once, on first
# cluster initialisation with an empty data directory. Any init file added
# after a database's volume already exists (e.g. 013_auth.sql, 014_auth_rls_bypass.sql)
# never reaches that database automatically. This script tracks which files
# have been applied in a schema_migrations table and applies the rest, in
# filename order, so it is safe to run repeatedly (including against a
# freshly initialised database where everything is already applied).
#
# Requires superuser/platform credentials (POSTGRES_USER/POSTGRES_PASSWORD) —
# migrations run DDL and GRANT statements the low-privilege app role must not
# hold. Run this at deploy time, not from application service startup.
set -euo pipefail

INIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/postgres/init"

PGHOST="${POSTGRES_HOST:-localhost}"
PGPORT="${POSTGRES_PORT:-5432}"
PGDATABASE="${POSTGRES_DB:-hyfib_wa}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER is required}"
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGHOST PGPORT PGDATABASE
# 002_app_role.sh (and any future .sh migration) reads these directly.
export POSTGRES_USER="$PGUSER"
export POSTGRES_DB="$PGDATABASE"

psql -v ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" \
  >/dev/null

applied_count=0
skipped_count=0

for file in "$INIT_DIR"/*; do
  name="$(basename "$file")"
  case "$name" in
    *.sql|*.sh) ;;
    *) continue ;;
  esac

  already_applied="$(psql -v ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" -tAc \
    "SELECT 1 FROM schema_migrations WHERE filename = '$name'")"
  if [ "$already_applied" = "1" ]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "Applying $name..."
  case "$name" in
    *.sql)
      psql -v ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" -f "$file"
      ;;
    *.sh)
      # 002_app_role.sh needs APP_DB_USER/APP_DB_PASSWORD and connects as $POSTGRES_USER itself.
      sh "$file"
      ;;
  esac

  psql -v ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" -c \
    "INSERT INTO schema_migrations (filename) VALUES ('$name') ON CONFLICT DO NOTHING;" >/dev/null
  applied_count=$((applied_count + 1))
done

echo "Migrations complete: $applied_count applied, $skipped_count already up to date."
