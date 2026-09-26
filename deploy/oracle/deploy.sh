#!/usr/bin/env bash
# Deploy the HyFib WhatsApp platform to an Oracle Cloud "Always Free" VM.
# Run from the Mac (any machine with ssh + rsync and this repo checked out):
#
#   deploy/oracle/deploy.sh <ssh-target> <domain> [acme-email]
#   e.g. deploy/oracle/deploy.sh ubuntu@129.146.1.2 hyfib.duckdns.org me@example.com
#
# First run provisions the VM (setup-vm.sh); every run syncs the source,
# builds on the VM, checks the new build's config, backs the database up if
# any migration is pending, applies the migrations, installs to /opt/hyfib/app,
# restarts the service and, once it is healthy, records the deploy in
# /var/lib/hyfib/deploys.log. Idempotent — re-run to redeploy. To roll back,
# see docs/runbooks/rollback.md.
set -euo pipefail

TARGET="${1:?usage: deploy.sh <ssh-target> <domain> [acme-email]}"
DOMAIN="${2:?usage: deploy.sh <ssh-target> <domain> [acme-email]}"
ACME_EMAIL="${3:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

log "syncing source to $TARGET:~/hyfib-src"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude .local-run \
  --exclude .env \
  --exclude .env.local \
  --exclude .DS_Store \
  --exclude '*.log' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT/" "$TARGET:hyfib-src/"

# What is being deployed, for the deploy log on the VM. rsync sends the working tree, not a commit, so
# uncommitted changes are flagged: that deploy cannot be reproduced from git.
VERSION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  VERSION="$VERSION+uncommitted"
fi

log "provisioning (first run only), building, migrating, installing ($VERSION)"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$DOMAIN" "$ACME_EMAIL" "$VERSION" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"; ACME_EMAIL="${2:-}"; VERSION="${3:-unknown}"
SRC="$HOME/hyfib-src"

# sudo: /etc/hyfib is root:root 750, so an unprivileged test -f would always
# be false and re-run provisioning on every deploy.
if ! sudo test -f /etc/hyfib/.provisioned; then
  if [ -n "$ACME_EMAIL" ]; then
    sudo bash "$SRC/deploy/oracle/setup-vm.sh" "$DOMAIN" "$ACME_EMAIL"
  else
    sudo bash "$SRC/deploy/oracle/setup-vm.sh" "$DOMAIN"
  fi
fi

cd "$SRC"
echo "▶ pnpm install"
pnpm install --frozen-lockfile
echo "▶ pnpm -r build"
pnpm -r build

# Catch a hyfib.env that is missing variables this build requires BEFORE
# touching the database or the running service — /etc/hyfib/hyfib.env is
# written once at provision time and never regenerated, so a new
# requireSecret() in packages/config would otherwise crash-loop the app after
# restart, and it would find the database already migrated.
echo "▶ validating /etc/hyfib/hyfib.env against the config schema"
sudo bash -c "set -a; . /etc/hyfib/hyfib.env; set +a; node --input-type=module -e 'import(\"$SRC/packages/config/dist/index.js\").then((m) => { m.loadConfig(); }).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); })'" \
  || { echo "ERROR: /etc/hyfib/hyfib.env is missing variables this build requires; edit it (sudo) and re-run" >&2; exit 1; }

# --backup-first: when any migration is pending, the database is backed up
# first, with the daily backup timer's settings (hyfib-backup.service), and
# nothing is applied if that fails. So a deploy that changes the schema can
# always be rolled back to the data it started from (docs/runbooks/rollback.md).
# Each migration statement gives up after MIGRATE_LOCK_TIMEOUT (default 5s)
# waiting for a lock, instead of stalling the app behind it.
echo "▶ applying database migrations (backing up first if any are pending)"
MIGRATE_LOG="$HOME/hyfib-last-migrate.log"
sudo bash -c "export BACKUP_DIR=/var/backups/hyfib; set -a; . /etc/hyfib/migrate.env; if [ -f /etc/hyfib/backup.env ]; then . /etc/hyfib/backup.env; fi; set +a; bash '$SRC/scripts/migrate.sh' --backup-first" 2>&1 | tee "$MIGRATE_LOG"

echo "▶ installing to /opt/hyfib/app"
# --delay-updates/--delete-delay stage new files and swap at the end so Caddy
# never serves a half-updated SPA; --chown replaces the full-tree chown pass.
sudo rsync -a --delete --delete-delay --delay-updates --chown=hyfib:hyfib "$SRC/" /opt/hyfib/app/
# Caddy (user caddy) serves the SPA straight from the app tree.
sudo chmod o+x /opt/hyfib /opt/hyfib/app /opt/hyfib/app/services /opt/hyfib/app/services/web-app
sudo chmod -R o+rX /opt/hyfib/app/services/web-app/dist

echo "▶ restarting hyfib-app"
sudo systemctl restart hyfib-app
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 1
done
# Hard gate: the loop above exits 0 on timeout, so re-check and fail loudly.
if ! curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "ERROR: hyfib-app did not become healthy after restart" >&2
  sudo journalctl -u hyfib-app -n 50 --no-pager >&2 || true
  exit 1
fi
echo "▶ health: $(curl -fsS http://127.0.0.1:8080/health)"

# One line per deploy that came up healthy: its last line is what is running,
# and the one before it is what to roll back to (docs/runbooks/rollback.md).
backup="$(sed -n 's/.* backup: done: //p' "$MIGRATE_LOG" | tail -n 1)"
applied="$(sed -n 's/^Applying \(.*\)\.\.\.$/\1/p' "$MIGRATE_LOG" | paste -sd, -)"
sudo install -d -m 750 /var/lib/hyfib
echo "$(date -u +%FT%TZ) version=$VERSION migrations=${applied:-none} backup=${backup:-none}" \
  | sudo tee -a /var/lib/hyfib/deploys.log >/dev/null
echo "▶ recorded in /var/lib/hyfib/deploys.log"
REMOTE

log "checking https://$DOMAIN/health from here"
if curl -fsS --max-time 15 "https://$DOMAIN/health" >/dev/null 2>&1; then
  log "DEPLOYED. Web UI: https://$DOMAIN"
else
  log "app is healthy on the VM, but https://$DOMAIN is not reachable yet."
  log "Usually DNS propagation or the security-list 80/443 ingress rules — retry in a minute."
fi
log "admin login: ssh $TARGET sudo cat /etc/hyfib/ADMIN_CREDENTIALS"
