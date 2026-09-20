#!/usr/bin/env bash
# Verifies that the configured CHANNEL_ENCRYPTION_KEY can decrypt every WhatsApp channel access
# token stored in the database.
#
# Why: the key lives only in /etc/hyfib/hyfib.env, never in a database dump (and must never be stored
# beside one). A replacement VM generates a NEW random key, so a restored database's channel tokens can
# no longer be decrypted until the original key is put back. Nothing else is lost — the fix is either the
# original key or re-entering each channel's token — but without this check the first sign is failing sends.
#
# Usage: verify-channel-key.sh [db]        (default: $POSTGRES_DB, else hyfib_wa)
#
# Env:
#   POSTGRES_HOST/PORT/USER/PASSWORD  as restore.sh (or already-exported PG* variables). The role must
#                                     be a superuser or have BYPASSRLS: whatsapp_channels is FORCE-RLS,
#                                     and any other role silently reads zero rows.
#   CHANNEL_ENCRYPTION_KEY            the key to test; if unset, read from HYFIB_ENV_FILE
#   HYFIB_ENV_FILE                    default /etc/hyfib/hyfib.env (only that one variable is read; the
#                                     file is never sourced)
#
# Exit: 0 verified, or could not verify (a NOTE/WARNING line says so)
#       3 tokens cannot be decrypted / key unusable
#       1 cannot query the database
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-channel-key.mjs"
SHARED_CORE_DIST="$SCRIPT_DIR/../packages/shared-core/dist/index.js"
ENV_FILE="${HYFIB_ENV_FILE:-/etc/hyfib/hyfib.env}"

db="${1:-${POSTGRES_DB:-hyfib_wa}}"

export PGHOST="${PGHOST:-${POSTGRES_HOST:-localhost}}"
export PGPORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER is required}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}}"

log() { printf '%s verify-key: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Extracts the single CHANNEL_ENCRYPTION_KEY= line's value (last one wins): trims surrounding whitespace,
# then one pair of matching quotes.
read_key_from_env_file() {
  local raw
  raw="$(sed -n 's/^CHANNEL_ENCRYPTION_KEY=//p' "$1" | tail -n 1)"
  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

key="${CHANNEL_ENCRYPTION_KEY:-}"
if [ -z "$key" ] && [ -r "$ENV_FILE" ]; then
  key="$(read_key_from_env_file "$ENV_FILE")"
fi

if [ -z "$key" ]; then
  log "NOTE: CHANNEL_ENCRYPTION_KEY is not available (not in the environment, nor readable from $ENV_FILE) — channel tokens NOT verified."
  log "NOTE: verify later with: sudo bash -c 'set -a; . /etc/hyfib/migrate.env; set +a; bash $SCRIPT_DIR/verify-channel-key.sh $db'"
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || [ ! -f "$SHARED_CORE_DIST" ]; then
  log "WARNING: cannot verify channel tokens — this needs node and a built packages/shared-core (run: pnpm build). Channel tokens NOT verified."
  exit 0
fi

# whatsapp_channels is FORCE-RLS: a role that does not bypass RLS reads zero rows WITHOUT an error, which
# would look exactly like "no tokens stored". Refuse to report anything in that case.
if ! bypass="$(psql -d "$db" -tAc "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")"; then
  log "ERROR: cannot query database '$db' as '$PGUSER'."
  exit 1
fi
if [ "$bypass" != "t" ]; then
  log "WARNING: role '$PGUSER' is subject to row-level security — channel tokens NOT verified (a superuser or BYPASSRLS role is required)."
  exit 0
fi

if ! rows="$(psql -d "$db" -At -F $'\t' -c "SELECT id, access_token_encrypted FROM whatsapp_channels WHERE access_token_encrypted IS NOT NULL ORDER BY id")"; then
  log "WARNING: could not read whatsapp_channels from '$db' — channel tokens NOT verified."
  exit 0
fi

# The key reaches the checker only through its environment; the rows on the pipe are ciphertext.
if report="$(printf '%s\n' "$rows" | CHANNEL_ENCRYPTION_KEY="$key" node "$CHECKER" 2>&1)"; then
  status=0
else
  status=$?
fi

while IFS= read -r line; do
  log "$line"
done <<< "$report"

case "$status" in
  0)
    exit 0
    ;;
  1)
    summary="$(printf '%s\n' "$report" | sed -n '1p')"
    log "ERROR: not all stored channel tokens can be decrypted with the configured CHANNEL_ENCRYPTION_KEY (${summary})."
    log "ERROR: outbound sends on the failing channels will fail until ONE of:"
    log "  (a) the ORIGINAL CHANNEL_ENCRYPTION_KEY (from your secrets escrow) is put into $ENV_FILE and hyfib-app is restarted, or"
    log "  (b) each failing channel's access token is re-entered (API only, there is no UI for this yet: PATCH /api/v1/channels/whatsapp/<id> with {\"accessToken\": ...}); it is re-encrypted under the current key."
    log "See docs/runbooks/dr-drill.md, \"DR-critical secrets\"."
    exit 3
    ;;
  *)
    log "ERROR: the configured CHANNEL_ENCRYPTION_KEY is unusable (see above); channel token encryption and decryption fail with it. Put the ORIGINAL key from your secrets escrow into $ENV_FILE (64 hex characters, or base64 of 32 bytes)."
    exit 3
    ;;
esac
