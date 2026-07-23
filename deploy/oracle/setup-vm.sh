#!/usr/bin/env bash
# One-time provisioning of an Oracle Cloud "Always Free" ARM VM (Ubuntu 22.04/24.04)
# for the HyFib WhatsApp platform. Installs Node 22, PostgreSQL 15, Redis and
# Caddy, opens ports 80/443, generates production secrets, and installs the
# systemd unit. Idempotent: safe to re-run.
#
# Run ON THE VM (deploy.sh does this for you on first deploy):
#   sudo bash setup-vm.sh <domain> [acme-email]
#
# The app itself is built and installed by deploy.sh, not here.
set -euo pipefail

DOMAIN="${1:?usage: sudo bash setup-vm.sh <domain> [acme-email]}"
ACME_EMAIL="${2:-}"

[ "$(id -u)" -eq 0 ] || { echo "must run as root (sudo)" >&2; exit 1; }

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive

# ── Packages ──────────────────────────────────────────────────────────────────
log "installing base packages"
apt-get update -q
apt-get install -qy curl git rsync jq openssl gnupg ca-certificates \
  debian-keyring debian-archive-keyring apt-transport-https lsb-release

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  log "installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -qy nodejs
fi

if ! command -v pnpm >/dev/null; then
  log "installing pnpm"
  npm install -g pnpm@10.12.1
fi

if ! command -v psql >/dev/null || ! psql --version | grep -q " 15\."; then
  log "installing PostgreSQL 15 (PGDG)"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
  apt-get install -qy postgresql-15 postgresql-client-15
fi
systemctl enable --now postgresql

if ! command -v redis-server >/dev/null; then
  log "installing Redis"
  apt-get install -qy redis-server
fi
systemctl enable --now redis-server

if ! command -v caddy >/dev/null; then
  log "installing Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -qy caddy
fi

# ── Firewall ──────────────────────────────────────────────────────────────────
# Oracle's Ubuntu images ship restrictive iptables rules (only 22 open) on top
# of the cloud security list — both layers must allow 80/443.
log "opening ports 80/443 in the VM firewall"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save || true

# ── Users and directories ─────────────────────────────────────────────────────
id hyfib >/dev/null 2>&1 || useradd --system --home /opt/hyfib --shell /usr/sbin/nologin hyfib
install -d -o hyfib -g hyfib /opt/hyfib /opt/hyfib/app
install -d -m 750 /etc/hyfib

# ── Secrets and environment ───────────────────────────────────────────────────
gen() { openssl rand -hex "$1"; }

if [ ! -f /etc/hyfib/migrate.env ]; then
  log "setting postgres superuser password"
  PG_SUPER_PASSWORD="$(gen 24)"
  APP_DB_PASSWORD="$(gen 24)"
  sudo -u postgres psql -qc "ALTER USER postgres PASSWORD '${PG_SUPER_PASSWORD}';"
  cat > /etc/hyfib/migrate.env <<EOF
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=hyfib_wa
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${PG_SUPER_PASSWORD}
APP_DB_USER=hyfib_app
APP_DB_PASSWORD=${APP_DB_PASSWORD}
EOF
  chmod 600 /etc/hyfib/migrate.env
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='hyfib_wa'" | grep -q 1 \
  || sudo -u postgres createdb hyfib_wa

if [ ! -f /etc/hyfib/hyfib.env ]; then
  log "generating /etc/hyfib/hyfib.env (production secrets)"
  # shellcheck disable=SC1091
  APP_DB_PASSWORD="$(. /etc/hyfib/migrate.env; echo "$APP_DB_PASSWORD")"
  ADMIN_PASSWORD="$(gen 12)"
  cat > /etc/hyfib/hyfib.env <<EOF
NODE_ENV=production
LOG_LEVEL=info
EVENT_BUS=memory
AUTH_ENABLED=true
ORG_TENANT_ID=00000000-0000-0000-0000-000000000001
ORG_NAME=HyFib
PLATFORM_BASE_URL=https://${DOMAIN}
APP_SERVER_PORT=8080
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=hyfib_wa
POSTGRES_APP_USER=hyfib_app
POSTGRES_APP_PASSWORD=${APP_DB_PASSWORD}
POSTGRES_SSL=false
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
WEBHOOK_VERIFY_TOKEN=$(gen 16)
META_APP_SECRET=$(gen 16)
CHANNEL_ENCRYPTION_KEY=$(gen 32)
INTERNAL_SERVICE_SECRET=$(gen 16)
BOOTSTRAP_ADMIN_EMAIL=admin@hyfib.local
BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
  chmod 600 /etc/hyfib/hyfib.env
  printf 'email: admin@hyfib.local\npassword: %s\n' "$ADMIN_PASSWORD" > /etc/hyfib/ADMIN_CREDENTIALS
  chmod 600 /etc/hyfib/ADMIN_CREDENTIALS
fi

# ── systemd unit ──────────────────────────────────────────────────────────────
log "installing systemd unit hyfib-app.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/hyfib-app.service" /etc/systemd/system/hyfib-app.service
systemctl daemon-reload
systemctl enable hyfib-app

# ── Caddy ─────────────────────────────────────────────────────────────────────
log "writing /etc/caddy/Caddyfile for ${DOMAIN}"
{
  if [ -n "$ACME_EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"; fi
  sed "s/__DOMAIN__/${DOMAIN}/g" "$SCRIPT_DIR/Caddyfile.template"
} > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

touch /etc/hyfib/.provisioned
log "provisioning complete. Deploy the app with deploy.sh, then:"
log "  admin login credentials: sudo cat /etc/hyfib/ADMIN_CREDENTIALS"
