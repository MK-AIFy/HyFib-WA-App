#!/usr/bin/env bash
# READ-ONLY pre-deploy audit of every stored tenant webhook URL (whatsapp_settings.status_callback_url) against the
# outbound-URL guard (SSRF) and the operator allowlist OUTBOUND_WEBHOOK_ALLOWLIST.
#
# Why: the guard refuses private, loopback, link-local and internal-name destinations at save time AND on every
# delivery. A URL stored before the guard existed that points at such a receiver silently stops receiving webhooks
# once the guard is deployed. Run this BEFORE deploying the guard, and again before changing the allowlist.
#
# Usage: audit-status-callback-urls.sh [--resolve] [db]        (default db: $POSTGRES_DB, else hyfib_wa)
#   --resolve   also resolve each host name with this machine's resolver and apply the connect-time rule (a name
#               that resolves to a private address). Run it ON THE APP HOST so names resolve as the app sees them.
#
# Env:
#   POSTGRES_HOST/PORT/USER/PASSWORD  as migrate.sh / verify-channel-key.sh (or already-exported PG* variables).
#                                     The role must be a superuser or have BYPASSRLS: whatsapp_settings is FORCE-RLS,
#                                     and any other role silently reads zero rows. On the Oracle VM that is
#                                     /etc/hyfib/migrate.env.
#   OUTBOUND_WEBHOOK_ALLOWLIST        the allowlist to test. When set — even to an empty value — it is used as given,
#                                     so a value can be tried before it is put in hyfib.env; when unset, the value is
#                                     read from HYFIB_ENV_FILE.
#   HYFIB_ENV_FILE                    default /etc/hyfib/hyfib.env (only that one variable is read; the file is never
#                                     sourced)
#
# Read-only: every psql session runs with default_transaction_read_only=on and issues SELECTs only.
# Output: per tenant, the verdict and scheme://host[:port] — never the path, query or signing secret.
# Exit: 0 every stored URL allowed (or none stored)
#       1 at least one stored URL would be blocked (gate the deploy)
#       2 could not audit (database unreachable, role subject to RLS, invalid allowlist, node/packages missing, usage)
#       3 nothing blocked, but a host name did not resolve (--resolve)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDITOR="$SCRIPT_DIR/audit-status-callback-urls.mjs"
SHARED_CORE_DIST="$SCRIPT_DIR/../packages/shared-core/dist/index.js"
CONFIG_DIST="$SCRIPT_DIR/../packages/config/dist/index.js"
ENV_FILE="${HYFIB_ENV_FILE:-/etc/hyfib/hyfib.env}"
RUNBOOK="docs/runbooks/outbound-webhook-allowlist.md"

log() { printf '%s audit-callbacks: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
usage() { printf 'usage: %s [--resolve] [db]\n' "$(basename "$0")" >&2; }

resolve=0
db=""
for arg in "$@"; do
  case "$arg" in
    --resolve) resolve=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) log "ERROR: unknown option '$arg'"; usage; exit 2 ;;
    *)
      if [ -n "$db" ]; then log "ERROR: more than one database given"; usage; exit 2; fi
      db="$arg"
      ;;
  esac
done
db="${db:-${POSTGRES_DB:-hyfib_wa}}"

# Extracts the last OUTBOUND_WEBHOOK_ALLOWLIST= line's value: trims surrounding whitespace, then one pair of
# matching quotes. The file is never sourced.
read_allowlist_from_env_file() {
  local raw
  raw="$(sed -n 's/^OUTBOUND_WEBHOOK_ALLOWLIST=//p' "$1" | tail -n 1)"
  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

if [ "${OUTBOUND_WEBHOOK_ALLOWLIST+set}" = set ]; then
  allowlist="$OUTBOUND_WEBHOOK_ALLOWLIST"
elif [ -r "$ENV_FILE" ]; then
  allowlist="$(read_allowlist_from_env_file "$ENV_FILE")"
else
  allowlist=""
  log "NOTE: OUTBOUND_WEBHOOK_ALLOWLIST is not in the environment and $ENV_FILE is not readable - auditing with NO allowlist (the strictest result)."
fi

if ! command -v node >/dev/null 2>&1 || [ ! -f "$SHARED_CORE_DIST" ] || [ ! -f "$CONFIG_DIST" ]; then
  log "ERROR: cannot audit - this needs node and built packages (packages/shared-core, packages/config: run pnpm build)."
  exit 2
fi

export PGHOST="${PGHOST:-${POSTGRES_HOST:-localhost}}"
export PGPORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER is required}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}}"
# Belt and braces for "never writes": the server refuses any write in these sessions.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on"

# whatsapp_settings is FORCE-RLS: a role that does not bypass RLS reads zero rows WITHOUT an error, which would look
# exactly like "no callback URLs stored" and pass the gate. Refuse to report anything in that case.
if ! bypass="$(psql -d "$db" -v ON_ERROR_STOP=1 -tAc "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")"; then
  log "ERROR: cannot query database '$db' as '$PGUSER'."
  exit 2
fi
if [ "$bypass" != "t" ]; then
  log "ERROR: role '$PGUSER' is subject to row-level security and would read no whatsapp_settings rows - not audited (a superuser or BYPASSRLS role is required, e.g. /etc/hyfib/migrate.env)."
  exit 2
fi

# Hex-encoded so no stored value (tabs, newlines, anything) can break the row format.
if ! rows="$(psql -d "$db" -v ON_ERROR_STOP=1 -At -F $'\t' -c "SELECT tenant_id, encode(convert_to(status_callback_url, 'UTF8'), 'hex') FROM whatsapp_settings WHERE status_callback_url IS NOT NULL AND status_callback_url <> '' ORDER BY tenant_id")"; then
  log "ERROR: could not read whatsapp_settings from '$db' - not audited."
  exit 2
fi

status=0
if [ "$resolve" = 1 ]; then
  printf '%s\n' "$rows" | OUTBOUND_WEBHOOK_ALLOWLIST="$allowlist" node "$AUDITOR" --resolve || status=$?
else
  printf '%s\n' "$rows" | OUTBOUND_WEBHOOK_ALLOWLIST="$allowlist" node "$AUDITOR" || status=$?
fi

case "$status" in
  0) ;;
  1) log "ERROR: stored callback URLs above would stop receiving webhooks. Either the tenant changes the URL, or - only for a receiver meant to be on a private network - an operator allowlists its host name AND address. See $RUNBOOK." ;;
  3) log "WARNING: some host names did not resolve from this machine; their connect-time verdict is unknown. Re-run on the app host, or re-run without --resolve to gate on the save-time rule only." ;;
  *) log "ERROR: the audit could not be completed (see above)." ;;
esac
exit "$status"
