#!/usr/bin/env bash
# PostgreSQL backup for HyFib (roadmap Phase C — the audit's single [critical]).
#
# Produces a timestamped pg_dump custom-format archive, verifies its integrity
# (pg_restore --list), writes a sha256 checksum, prunes old local copies, and
# optionally ships the dump off-host. Designed to run identically on the
# production VM (system postgres, driven by /etc/hyfib/migrate.env via the
# hyfib-backup systemd timer), in CI (the backup-restore drill job), and
# against a local dev stack.
#
# Env:
#   POSTGRES_HOST (default localhost)   POSTGRES_PORT (default 5432)
#   POSTGRES_DB   (default hyfib_wa)    POSTGRES_USER (required)
#   POSTGRES_PASSWORD (required)
#   BACKUP_DIR        target directory (default /var/backups/hyfib)
#   BACKUP_RETENTION  local dumps to keep, newest first (default 14)
#   BACKUP_REMOTE_CMD optional command invoked as: $BACKUP_REMOTE_CMD <dump>
#                     (e.g. an rclone/OCI-CLI wrapper). A backup that never
#                     leaves the host is not DR: when set, its failure fails
#                     this script so the timer unit goes red.
set -euo pipefail

PGHOST="${POSTGRES_HOST:-localhost}"
PGPORT="${POSTGRES_PORT:-5432}"
PGDATABASE="${POSTGRES_DB:-hyfib_wa}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER is required}"
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGHOST PGPORT PGDATABASE PGUSER

BACKUP_DIR="${BACKUP_DIR:-/var/backups/hyfib}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/${PGDATABASE}_${stamp}.dump"

log "dumping ${PGDATABASE}@${PGHOST}:${PGPORT} -> ${dump}"
pg_dump --format=custom --compress=6 --file="$dump"

# Integrity: a dump pg_restore cannot even list is not a backup.
pg_restore --list "$dump" >/dev/null
log "integrity check passed ($(du -h "$dump" | cut -f1))"

if command -v sha256sum >/dev/null; then
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$dump")" > "$(basename "$dump").sha256")
else
  (cd "$BACKUP_DIR" && shasum -a 256 "$(basename "$dump")" > "$(basename "$dump").sha256")
fi

# Retention: keep the newest N dumps (and their checksums), delete the rest.
prune_list="$(ls -1t "$BACKUP_DIR"/${PGDATABASE}_*.dump 2>/dev/null | tail -n "+$((BACKUP_RETENTION + 1))")"
if [ -n "$prune_list" ]; then
  while IFS= read -r old; do
    log "pruning $(basename "$old")"
    rm -f "$old" "$old.sha256"
  done <<< "$prune_list"
fi

if [ -n "${BACKUP_REMOTE_CMD:-}" ]; then
  log "shipping off-host via: ${BACKUP_REMOTE_CMD}"
  if ! ${BACKUP_REMOTE_CMD} "$dump"; then
    log "ERROR: off-host shipping failed — treating the backup run as FAILED"
    exit 1
  fi
  log "off-host copy complete"
else
  log "WARNING: BACKUP_REMOTE_CMD unset — dump exists only on this host"
fi

log "done: $dump"
