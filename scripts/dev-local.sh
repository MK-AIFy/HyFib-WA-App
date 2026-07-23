#!/usr/bin/env bash
# Run the whole HyFib WhatsApp platform locally WITHOUT Docker.
#
# The app-server is a modular monolith: one Node process runs the gateway,
# in-process workers, and the meta-adapter. With EVENT_BUS=memory it needs no
# RabbitMQ — only PostgreSQL and Redis, both of which run natively (Homebrew).
#
# Usage:
#   scripts/dev-local.sh up      # bootstrap DB, build, start app-server + web-app
#   scripts/dev-local.sh seed    # add a demo channel, inbound conversation, template
#   scripts/dev-local.sh down    # stop app-server + web-app (leaves Postgres/Redis)
#   scripts/dev-local.sh status  # show what's listening
#
# Login (web UI): admin@hyfib.local / hyfib-admin-2026
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local"
RUN_DIR="$ROOT/.local-run"
mkdir -p "$RUN_DIR"
# Fail with a message (not a silent set -e death) when the formula is absent.
if ! PG_PREFIX="$(brew --prefix postgresql@15 2>/dev/null)"; then
  echo "postgresql@15 not found via Homebrew — install it with: brew install postgresql@15" >&2
  exit 1
fi
export PATH="$PG_PREFIX/bin:$PATH"

ADMIN_EMAIL="admin@hyfib.local"
ADMIN_PASSWORD="hyfib-admin-2026"
ORG_ID="00000000-0000-0000-0000-000000000001"
APP_PORT=8080
WEB_PORT=5173

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

ensure_env() {
  [ -f "$ENV_FILE" ] && return
  log "generating .env.local (random dev secrets, memory bus, AUTH_ENABLED=false)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=development
LOG_LEVEL=info
EVENT_BUS=memory
AUTH_ENABLED=false
ORG_TENANT_ID=$ORG_ID
ORG_NAME=HyFib
PLATFORM_BASE_URL=http://localhost:$APP_PORT
APP_SERVER_PORT=$APP_PORT
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=hyfib_wa
POSTGRES_APP_USER=hyfib_app
POSTGRES_APP_PASSWORD=hyfib_app
POSTGRES_SSL=false
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 16)
META_APP_SECRET=$(openssl rand -hex 16)
CHANNEL_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_SERVICE_SECRET=$(openssl rand -hex 16)
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
}

ensure_infra() {
  log "ensuring Postgres + Redis are running"
  brew services list | grep -q '^postgresql@15 *started' || brew services start postgresql@15 >/dev/null
  brew services list | grep -q '^redis *started' || brew services start redis >/dev/null
  for _ in $(seq 1 30); do pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break; sleep 1; done
  createdb -h 127.0.0.1 -p 5432 hyfib_wa 2>/dev/null || true
}

migrate() {
  log "applying database migrations"
  POSTGRES_USER="$USER" POSTGRES_PASSWORD=x POSTGRES_DB=hyfib_wa \
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 \
    APP_DB_USER=hyfib_app APP_DB_PASSWORD=hyfib_app \
    bash "$ROOT/scripts/migrate.sh"
}

start_app() {
  log "starting app-server on :$APP_PORT"
  ( set -a; . "$ENV_FILE"; set +a; nohup node "$ROOT/services/app-server/dist/main.js" \
      > "$RUN_DIR/app-server.log" 2>&1 & echo $! > "$RUN_DIR/app-server.pid" )
  for _ in $(seq 1 30); do
    curl -fsS "http://localhost:$APP_PORT/health" >/dev/null 2>&1 && { log "app-server healthy"; return; }
    sleep 1
  done
  echo "app-server did not become healthy; see $RUN_DIR/app-server.log" >&2; exit 1
}

start_web() {
  log "starting web-app (Vite) on :$WEB_PORT"
  ( cd "$ROOT/services/web-app"; nohup pnpm dev > "$RUN_DIR/web-app.log" 2>&1 & echo $! > "$RUN_DIR/web-app.pid" )
  sleep 4
}

cmd_up() {
  ensure_env
  ensure_infra
  migrate
  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    log "SKIP_BUILD=1 — skipping workspace build"
  else
    # web-app is excluded: its production bundle is unused here because
    # start_web runs the Vite dev server. SKIP_BUILD=1 skips the compile
    # entirely for restart-only loops.
    log "building workspace (pnpm -r build, minus web-app)"
    pnpm -r --filter '!@hyfib/web-app' build >/dev/null
  fi
  start_app
  start_web
  echo
  log "UP. Web UI: http://localhost:$WEB_PORT   (login: $ADMIN_EMAIL / $ADMIN_PASSWORD)"
  log "API:     http://localhost:$APP_PORT/health"
  log "Seed demo data: scripts/dev-local.sh seed"
}

cmd_seed() {
  set -a; . "$ENV_FILE"; set +a
  # Full epoch + $RANDOM: unique per run (the old 6-digit truncation collided
  # on same-second reruns and every ~11.6 days, silently 409ing).
  local base="http://localhost:$APP_PORT" pn="1550$(date +%s)$RANDOM" phone="15558675309"
  log "registering channel ($pn) + inbound webhook + approved template"
  curl -fsS -X POST "$base/api/v1/channels/whatsapp" -H 'content-type: application/json' \
    -H 'x-role: tenant_admin' -H "x-tenant-id: $ORG_ID" \
    -d "{\"wabaId\":\"000000000000000\",\"phoneNumberId\":\"$pn\",\"displayPhoneNumber\":\"+15550001111\"}" >/dev/null \
    || { echo "channel registration failed" >&2; exit 1; }
  local payload sig
  payload=$(jq -cn --arg pn "$pn" --arg from "$phone" \
    '{entry:[{id:"waba",changes:[{value:{metadata:{phone_number_id:$pn},contacts:[{wa_id:$from,profile:{name:"Sam Rivera"}}],messages:[{id:("wamid.LOCAL."+$pn),from:$from,type:"text",text:{body:"Hi, I need help with my order #4471"},timestamp:"1700000000"}]}}]}]}')
  sig="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | awk '{print $2}')"
  curl -fsS -X POST "$base/api/v1/webhooks/meta/whatsapp" -H 'content-type: application/json' \
    -H "x-hub-signature-256: $sig" -d "$payload" >/dev/null \
    || { echo "webhook ingestion failed — likely a stale META_APP_SECRET in .env.local vs the running app-server" >&2; exit 1; }
  local tpl
  tpl=$(curl -sS -X POST "$base/api/v1/templates" -H 'content-type: application/json' \
    -H 'x-role: marketing_manager' -H "x-tenant-id: $ORG_ID" \
    -d '{"name":"order_update","category":"utility","language":"en","body":"Hi {{1}}, your order {{2}} has shipped and will arrive by {{3}}."}' | jq -r '.id // empty')
  # UUID-validate before interpolating into SQL: never trust a server response
  # inside a psql string, and be honest when the template step is skipped.
  if [[ "$tpl" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    psql -h 127.0.0.1 -d hyfib_wa -c "UPDATE templates SET status='approved' WHERE id='$tpl';" >/dev/null
    log "template order_update approved"
  else
    log "template not created (may already exist from a prior seed) — skipping approval"
  fi
  log "seeded. Open the inbox and pick the conversation."
}

cmd_down() {
  for svc in web-app app-server; do
    [ -f "$RUN_DIR/$svc.pid" ] && kill "$(cat "$RUN_DIR/$svc.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/$svc.pid"
  done
  lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
  lsof -nP -iTCP:$APP_PORT -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
  log "stopped app-server + web-app (Postgres/Redis left running)"
}

cmd_status() {
  lsof -nP -iTCP:$APP_PORT -iTCP:$WEB_PORT -sTCP:LISTEN 2>/dev/null || echo "nothing listening on $APP_PORT/$WEB_PORT"
}

case "${1:-up}" in
  up) cmd_up ;;
  seed) cmd_seed ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|seed|down|status}" >&2; exit 2 ;;
esac
