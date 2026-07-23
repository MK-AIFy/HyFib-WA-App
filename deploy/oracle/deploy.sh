#!/usr/bin/env bash
# Deploy the HyFib WhatsApp platform to an Oracle Cloud "Always Free" VM.
# Run from the Mac (any machine with ssh + rsync and this repo checked out):
#
#   deploy/oracle/deploy.sh <ssh-target> <domain> [acme-email]
#   e.g. deploy/oracle/deploy.sh ubuntu@129.146.1.2 hyfib.duckdns.org me@example.com
#
# First run provisions the VM (setup-vm.sh); every run syncs the source,
# builds on the VM, applies DB migrations, installs to /opt/hyfib/app and
# restarts the service. Idempotent — re-run to redeploy.
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

log "provisioning (first run only), building, migrating, installing"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$DOMAIN" "$ACME_EMAIL" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"; ACME_EMAIL="${2:-}"
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

echo "▶ applying database migrations"
sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; bash '$SRC/scripts/migrate.sh'"

# Catch a hyfib.env that is missing variables this build requires BEFORE
# touching the running service — /etc/hyfib/hyfib.env is written once at
# provision time and never regenerated, so a new requireSecret() in
# packages/config would otherwise crash-loop the app after restart.
echo "▶ validating /etc/hyfib/hyfib.env against the config schema"
sudo bash -c "set -a; . /etc/hyfib/hyfib.env; set +a; node --input-type=module -e 'import(\"$SRC/packages/config/dist/index.js\").then((m) => { m.loadConfig(); }).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); })'" \
  || { echo "ERROR: /etc/hyfib/hyfib.env is missing variables this build requires; edit it (sudo) and re-run" >&2; exit 1; }

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
REMOTE

log "checking https://$DOMAIN/health from here"
if curl -fsS --max-time 15 "https://$DOMAIN/health" >/dev/null 2>&1; then
  log "DEPLOYED. Web UI: https://$DOMAIN"
else
  log "app is healthy on the VM, but https://$DOMAIN is not reachable yet."
  log "Usually DNS propagation or the security-list 80/443 ingress rules — retry in a minute."
fi
log "admin login: ssh $TARGET sudo cat /etc/hyfib/ADMIN_CREDENTIALS"
