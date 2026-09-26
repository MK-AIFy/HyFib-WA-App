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
#
# Usage: migrate.sh [--pending | --backup-first]
#   (no argument)   apply every pending migration, in filename order
#   --pending       list the pending migrations, one per line, and apply nothing
#   --backup-first  if any migration is pending, first run scripts/backup.sh (BACKUP_DIR, BACKUP_RETENTION,
#                   BACKUP_REMOTE_CMD as for that script), and apply nothing if the backup fails.
#                   deploy/oracle/deploy.sh migrates this way.
#
# Every migration statement runs with lock_timeout (MIGRATE_LOCK_TIMEOUT, default 5s): a statement that cannot
# get its lock in time fails, instead of queueing every app query on that table behind it for as long as it
# waits. A file is recorded as applied only once all of it has run, so re-running retries a failed one from the
# top: migrations must be safe to re-run (IF NOT EXISTS, CREATE OR REPLACE, ...). See docs/runbooks/rollback.md.
set -euo pipefail

mode=apply
case "${1:-}" in
  "") ;;
  --pending) mode=pending ;;
  --backup-first) mode=backup-first ;;
  *)
    echo "usage: migrate.sh [--pending | --backup-first]" >&2
    exit 2
    ;;
esac

# MIGRATIONS_DIR: for tests; production always uses infra/postgres/init.
INIT_DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/postgres/init}"

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

# The migration files not yet recorded in schema_migrations, in filename order. It runs in a subshell, where
# set -e does not reach, so a failed query is passed on explicitly rather than read as "not applied".
pending_migrations() {
  local file name applied
  for file in "$INIT_DIR"/*; do
    name="$(basename "$file")"
    case "$name" in
      *.sql|*.sh) ;;
      *) continue ;;
    esac
    applied="$(psql -v ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" -tAc \
      "SELECT 1 FROM schema_migrations WHERE filename = '$name'")" || return 1
    if [ "$applied" != "1" ]; then
      echo "$name"
    fi
  done
}

if [ "$mode" != apply ]; then
  pending="$(pending_migrations)"
  if [ "$mode" = pending ]; then
    if [ -n "$pending" ]; then
      printf '%s\n' "$pending"
    fi
    exit 0
  fi
  if [ -n "$pending" ]; then
    echo "Backing up before applying $(printf '%s\n' "$pending" | wc -l | tr -d ' ') pending migration(s)..."
    bash "$(dirname "${BASH_SOURCE[0]}")/backup.sh"
  fi
fi

# From here on, every statement a migration runs (a .sh migration's own psql calls included) gives up after
# MIGRATE_LOCK_TIMEOUT waiting for a lock. Set after the backup: pg_dump must not give up on a lock that soon.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c lock_timeout=${MIGRATE_LOCK_TIMEOUT:-5s}"

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
