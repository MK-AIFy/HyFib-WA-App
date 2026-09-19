#!/usr/bin/env bash
# Restores a scripts/backup.sh dump into PostgreSQL, with guardrails.
#
# Usage: restore.sh <dump-file> [target-db]
#
# The target database is DROPPED and recreated — this is a disaster-recovery
# tool, not a merge. It refuses to touch a database that currently has any
# connected clients, and refuses to drop an existing database unless
# RESTORE_FORCE=1, so a fat-fingered invocation cannot silently destroy prod.
# Prints post-restore evidence (migration + tenant counts, RLS spot-check) for
# the DR-drill log, then verifies that the configured CHANNEL_ENCRYPTION_KEY can
# decrypt the restored channel tokens (scripts/verify-channel-key.sh) and exits 3
# if it cannot. A missing key or a role that cannot read the tokens only prints a
# NOTE/WARNING and does not change the exit status.
#
# Env: POSTGRES_HOST/PORT/USER/PASSWORD as backup.sh (superuser/platform
# credentials — restore recreates the DB and needs to run DDL + GRANTs).
set -euo pipefail

dump="${1:?usage: restore.sh <dump-file> [target-db]}"
target="${2:-${POSTGRES_DB:-hyfib_wa}}"

PGHOST="${POSTGRES_HOST:-localhost}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER is required}"
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGHOST PGPORT PGUSER

log() { printf '%s restore: %s\n' "$(date -u +%FT%TZ)" "$*"; }

[ -f "$dump" ] || { log "ERROR: dump not found: $dump"; exit 1; }

if [ -f "$dump.sha256" ]; then
  log "verifying checksum"
  (cd "$(dirname "$dump")" && { sha256sum -c "$(basename "$dump").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$dump").sha256"; }) >/dev/null
  log "checksum ok"
else
  log "WARNING: no .sha256 next to the dump — skipping checksum verification"
fi

pg_restore --list "$dump" >/dev/null || { log "ERROR: dump fails pg_restore --list"; exit 1; }

exists="$(psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$target'" || true)"
if [ "$exists" = "1" ]; then
  if [ "${RESTORE_FORCE:-0}" != "1" ]; then
    log "ERROR: database '$target' exists. Set RESTORE_FORCE=1 to drop and recreate it."
    exit 1
  fi
  clients="$(psql -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid()")"
  if [ "$clients" != "0" ]; then
    log "ERROR: database '$target' has $clients connected client(s). Stop the app first."
    exit 1
  fi
  log "dropping existing database '$target'"
  psql -d postgres -qc "DROP DATABASE \"$target\""
fi

log "creating database '$target'"
psql -d postgres -qc "CREATE DATABASE \"$target\""

log "restoring $dump -> $target"
# --no-owner: objects become the restoring role; ACLs from GRANTs are kept.
pg_restore --dbname="$target" --no-owner --exit-on-error "$dump"

log "post-restore evidence:"
psql -d "$target" -tAc "SELECT 'migrations applied: ' || count(*) FROM schema_migrations"
psql -d "$target" -tAc "SELECT 'tenants: ' || count(*) FROM tenants"
psql -d "$target" -tAc "SELECT 'RLS forced on contacts: ' || relforcerowsecurity FROM pg_class WHERE relname = 'contacts'"

# Channel access tokens are encrypted with CHANNEL_ENCRYPTION_KEY, which is deliberately NOT in the dump.
# A replacement VM generates a different key, so check now that the configured key can still decrypt what
# was just restored (exit 3 = database restored, environment not fully recovered).
verify_status=0
bash "$(dirname "${BASH_SOURCE[0]}")/verify-channel-key.sh" "$target" || verify_status=$?

log "done"
exit "$verify_status"
