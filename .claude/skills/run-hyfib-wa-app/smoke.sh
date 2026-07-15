#!/usr/bin/env bash
# Credential-free smoke driver for the HyFib WhatsApp platform.
#
# Brings up the full docker compose stack and drives one end-to-end flow
# with header identity (AUTH_ENABLED=false): fixed single-org tenant -> user
# -> channel (dummy ids, no Meta calls) -> contact -> consent -> template
# (DB-approved) -> campaign -> dispatch -> signed inbound webhook ->
# conversation -> agent reply -> history -> analytics -> audit -> SSE probe.
#
# Usage:
#   .claude/skills/run-hyfib-wa-app/smoke.sh                  # full run
#   SKIP_COMPOSE_UP=1 .claude/skills/run-hyfib-wa-app/smoke.sh # stack already up
#   .claude/skills/run-hyfib-wa-app/smoke.sh --bootstrap-env-only <path>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

BASE="${BASE_URL:-http://localhost:18080}"
PORTAL="${WEB_PORTAL_URL:-http://localhost:3001}"
EDGE="${EDGE_URL:-https://localhost}"

step() { echo; echo "== $* =="; }
fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

for c in docker curl jq openssl; do
  command -v "$c" >/dev/null 2>&1 || fail "missing required command: $c"
done

# .env.example ships placeholder secrets ("change-me"/"replace-me"); give every
# secret a unique random value and force the local header-identity auth mode.
bootstrap_env() {
  local target="$1"
  awk -F= '
    /^(WEBHOOK_VERIFY_TOKEN|META_APP_SECRET|POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD|REDIS_PASSWORD|RABBITMQ_DEFAULT_PASS|MINIO_ROOT_PASSWORD|KEYCLOAK_ADMIN_PASSWORD|VAULT_DEV_ROOT_TOKEN_ID|OPENSEARCH_ADMIN_PASSWORD)=/ {
      cmd = "openssl rand -hex 16"; cmd | getline v; close(cmd)
      print $1 "=" v; next
    }
    /^CHANNEL_ENCRYPTION_KEY=/ {
      cmd = "openssl rand -hex 32"; cmd | getline v; close(cmd)
      print $1 "=" v; next
    }
    /^AUTH_ENABLED=/ { print "AUTH_ENABLED=false"; next }
    { print }
  ' .env.example > "$target"
  chmod 600 "$target"
}

if [[ "${1:-}" == "--bootstrap-env-only" ]]; then
  bootstrap_env "${2:?usage: smoke.sh --bootstrap-env-only <path>}"
  echo "wrote ${2}"
  exit 0
fi

if [[ ! -f .env ]]; then
  step ".env missing — bootstrapping with random dev secrets (AUTH_ENABLED=false)"
  bootstrap_env .env
  if docker volume ls --format '{{.Name}}' | grep -q 'pg_primary_data'; then
    echo "WARNING: an existing postgres volume was initialized with the OLD passwords."
    echo "Run 'docker compose down -v' before continuing so the new .env takes effect."
  fi
fi

grep -q '^AUTH_ENABLED=false' .env ||
  fail ".env must set AUTH_ENABLED=false (this driver uses x-role/x-tenant-id header identity); recreate services after changing it"

./scripts/generate-dev-tls-cert.sh >/dev/null

if [[ "${SKIP_COMPOSE_UP:-}" != "1" ]]; then
  step "docker compose up --build -d (first build takes several minutes)"
  docker compose up --build -d
fi

step "waiting for api-gateway health (database-backed)"
for i in $(seq 1 60); do
  if curl -fsS -m 3 "$BASE/health" 2>/dev/null | jq -e '.database == true' >/dev/null 2>&1; then
    break
  fi
  [[ "$i" == 60 ]] && fail "gateway not healthy after 120s — check: docker compose logs api-gateway"
  sleep 2
done
curl -fsS "$BASE/health" | jq -c .
curl -fsS -m 5 "$PORTAL/health" | jq -c .
curl -fsSk -m 5 -A "Mozilla/5.0" "$EDGE/health" | jq -c .

# Gateway health only proves the DB is up. The eventing path needs the AMQP
# listener, which comes up well after the gateway on a cold start. NOTE:
# `rabbitmq-diagnostics ping` passes before the listener accepts connections;
# check_port_connectivity is the real signal.
step "waiting for rabbitmq AMQP listener"
for i in $(seq 1 30); do
  if docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then
    break
  fi
  [[ "$i" == 30 ]] && fail "rabbitmq not ready after 60s — check: docker compose logs rabbitmq"
  sleep 2
done
echo "rabbitmq OK"

# The ingestor isn't host-exposed; probe its health from inside the container.
step "waiting for webhook-ingestor"
for i in $(seq 1 30); do
  if docker compose exec -T webhook-ingestor node -e "fetch('http://127.0.0.1:8093/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  [[ "$i" == 30 ]] && fail "webhook-ingestor not ready after 60s — check: docker compose logs webhook-ingestor"
  sleep 2
done
echo "webhook-ingestor OK"

SECRET="$(grep -E '^META_APP_SECRET=' .env | head -n1 | cut -d= -f2-)"
PG_USER="$(grep -E '^POSTGRES_USER=' .env | head -n1 | cut -d= -f2-)"
PG_DB="$(grep -E '^POSTGRES_DB=' .env | head -n1 | cut -d= -f2-)"
# Fresh phone-number id per run: webhook -> tenant routing is by phoneNumberId,
# so reusing one across runs would route events to the oldest matching channel.
PN_ID="$(date +%s)$((RANDOM % 900 + 100))"
# Fixed org id: this driver no longer creates a tenant per run (POST
# /api/v1/tenants is retired). All entities land in the single seeded org, so
# identities that used to be scoped to a fresh tenant each run (contact phone,
# user email, template name) must be made unique per run instead, or they'll
# collide with rows left behind by a previous run against a persistent DB
# volume. PN_ID (already unique per run) is reused for that.
PHONE="+1555${PN_ID: -7}"

api() { # method path role tenant [json-body]
  local method="$1" path="$2" role="$3" tenant="$4" body="${5:-}"
  local args=(-fsS -X "$method" "$BASE$path" -H 'content-type: application/json' -H "x-role: $role")
  [[ -n "$tenant" ]] && args+=(-H "x-tenant-id: $tenant")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}

step "org + user"
# The backend serves a single fixed org now (POST /api/v1/tenants is retired).
# infra/postgres/init/013_auth.sql seeds this id on fresh installs;
# ORG_TENANT_ID overrides it for pinned deployments.
TENANT_ID="${ORG_TENANT_ID:-00000000-0000-0000-0000-000000000001}"
echo "TENANT_ID=$TENANT_ID"
# Email must be unique per run: user creation 409s on a duplicate email, and
# with the org fixed across runs the same literal email would collide against
# a persistent DB volume.
api POST /api/v1/users tenant_admin "$TENANT_ID" "{\"email\":\"admin+$PN_ID@smoke.example\",\"displayName\":\"Smoke Admin\",\"roles\":[\"tenant_admin\",\"marketing_manager\"]}" | jq -c '{id,email}'

step "whatsapp channel with dummy ids (no Meta Graph calls)"
api POST /api/v1/channels/whatsapp tenant_admin "$TENANT_ID" "{\"wabaId\":\"000000000000000\",\"phoneNumberId\":\"$PN_ID\",\"displayPhoneNumber\":\"+15550001111\"}" | jq -c '{id,status}'

step "role gate: analyst POST /contacts must be 403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/contacts" -H 'content-type: application/json' -H 'x-role: analyst' -H "x-tenant-id: $TENANT_ID" -d "{\"phoneE164\":\"$PHONE\"}")
[[ "$code" == "403" ]] || fail "expected 403 for analyst contact create, got $code"
echo "403 as expected"

step "contact + consent"
CONTACT_ID=$(api POST /api/v1/contacts marketing_manager "$TENANT_ID" "{\"phoneE164\":\"$PHONE\",\"firstName\":\"Sam\"}" | jq -r '.id // empty')
[[ -n "$CONTACT_ID" ]] || fail "contact create"
api POST "/api/v1/contacts/$CONTACT_ID/consent" marketing_manager "$TENANT_ID" '{"source":"smoke","policyVersion":"v1"}' | jq -c .

step "template (DB-approved, Meta approval is async in real envs) + campaign + test dispatch"
# Template name is unique per (tenant, name, language); suffix with PN_ID so
# reruns against the fixed org don't collide with a prior run's template.
TEMPLATE_ID=$(api POST /api/v1/templates marketing_manager "$TENANT_ID" "{\"name\":\"smoke_offer_v1_$PN_ID\",\"category\":\"marketing\",\"language\":\"en\",\"body\":\"Hi {{1}}, enjoy 20% off.\"}" | jq -r '.id // empty')
[[ -n "$TEMPLATE_ID" ]] || fail "template create"
docker compose exec -T postgres-primary psql -U "$PG_USER" -d "$PG_DB" \
  -c "UPDATE templates SET status='approved' WHERE id='$TEMPLATE_ID';" >/dev/null
CAMPAIGN_ID=$(api POST /api/v1/campaigns marketing_manager "$TENANT_ID" "{\"name\":\"Smoke Batch\",\"templateId\":\"$TEMPLATE_ID\"}" | jq -r '.id // empty')
[[ -n "$CAMPAIGN_ID" ]] || fail "campaign create"
# Phase 0: policy computed server-side — only contactPhoneE164 + parameters sent
DISPATCH=$(api POST "/api/v1/campaigns/$CAMPAIGN_ID/dispatch" marketing_manager "$TENANT_ID" "{\"contactPhoneE164\":\"$PHONE\",\"parameters\":[\"Sam\"]}")
echo "$DISPATCH" | jq -e '.status == "dispatch_enqueued"' >/dev/null || fail "dispatch: $DISPATCH"
echo "$DISPATCH" | jq -c .
echo "(worker will log dispatch_failed meta_adapter_rejected_503 — expected without real Meta credentials)"

step "CSV contact import (Phase 1)"
CSV_BODY="phone_e164,first_name,consent
+15551110001,Bob,true
+15551110002,Carol,true
+15551110003,Dave,false"
IMPORT_RESP=$(curl -fsS -X POST "$BASE/api/v1/contacts/import" \
  -H "x-role: marketing_manager" -H "x-tenant-id: $TENANT_ID" \
  -H "content-type: text/csv" \
  --data-raw "$CSV_BODY")
# bulkUpsert (ON CONFLICT DO UPDATE on tenant_id+phone_e164) means a rerun
# against the fixed org sees these same phone numbers as updates, not
# creates — assert on the combined count so the driver tolerates reruns.
echo "$IMPORT_RESP" | jq -e '(.created + .updated) >= 3' >/dev/null || fail "CSV import: $IMPORT_RESP"
echo "CSV import: $(echo "$IMPORT_RESP" | jq -c '{created,updated,skipped}') errors=$(echo "$IMPORT_RESP" | jq '.errors|length')"

step "segment create + preview (Phase 1)"
SEG_ID=$(api POST /api/v1/segments marketing_manager "$TENANT_ID" '{"name":"All Consented","definition":{"hasConsent":true}}' | jq -r '.id // empty')
[[ -n "$SEG_ID" ]] || fail "segment create"
PREVIEW=$(api GET "/api/v1/segments/$SEG_ID/preview" marketing_manager "$TENANT_ID")
echo "$PREVIEW" | jq -e '.count >= 1' >/dev/null || fail "segment preview: $PREVIEW"
echo "segment $SEG_ID — preview count=$(echo "$PREVIEW" | jq '.count')"

step "campaign fan-out run (Phase 2)"
RUN_CAMPAIGN_ID=$(api POST /api/v1/campaigns marketing_manager "$TENANT_ID" \
  "{\"name\":\"Smoke Fan-out\",\"templateId\":\"$TEMPLATE_ID\",\"segmentId\":\"$SEG_ID\",\"variableMapping\":{\"1\":\"firstName\"},\"ratePerMinute\":60}" \
  | jq -r '.id // empty')
[[ -n "$RUN_CAMPAIGN_ID" ]] || fail "fan-out campaign create"
RUN_RESP=$(api POST "/api/v1/campaigns/$RUN_CAMPAIGN_ID/run" marketing_manager "$TENANT_ID" '{}')
echo "$RUN_RESP" | jq -e '.recipientCount >= 1' >/dev/null || fail "campaign run: $RUN_RESP"
echo "fan-out enqueued: $(echo "$RUN_RESP" | jq -c '{recipientCount,status}')"

step "funnel report (Phase 5)"
REPORT=$(api GET "/api/v1/campaigns/$RUN_CAMPAIGN_ID/report" marketing_manager "$TENANT_ID")
echo "$REPORT" | jq -e 'has("funnel")' >/dev/null || fail "funnel report: $REPORT"
echo "funnel: $(echo "$REPORT" | jq -c '.funnel')"

step "auto-reply rule create (Phase 3)"
RULE_ID=$(api POST /api/v1/auto-reply-rules support_agent "$TENANT_ID" \
  '{"matchType":"keyword","keyword":"help","replyKind":"text","replyText":"How can I help you today?","enabled":true,"priority":10}' \
  | jq -r '.id // empty')
[[ -n "$RULE_ID" ]] || fail "auto-reply rule create"
echo "auto-reply rule $RULE_ID created"

step "signed inbound webhook (HMAC with META_APP_SECRET) -> conversation"
# A webhook 200 only proves the ingestor PUBLISHED the event; it does not
# prove anyone consumed it. On a cold start, events published before the
# worker asserts its queues are silently dropped (default-exchange routing,
# no mandatory flag), and services back off up to 30s before reconnecting to
# the broker. So: send a FRESH message id each attempt (the gateway records
# the idempotency key even when its upstream call fails, so resending an
# identical payload returns "duplicate_ignored" without ingesting), and keep
# sending until a conversation appears — the only real proof of consumption.
CONV_ID=""
for i in $(seq 1 15); do
  PAYLOAD=$(jq -cn --arg pn "$PN_ID" --arg from "$PHONE" --arg mid "wamid.SMOKE.$PN_ID.$i" '{entry:[{id:"waba",changes:[{value:{metadata:{phone_number_id:$pn},contacts:[{wa_id:$from,profile:{name:"Sam Test"}}],messages:[{id:$mid,from:$from,type:"text",text:{body:"hello there"},timestamp:"1700000000"}]}}]}]}')
  SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
  RESP=$(curl -fsS -X POST "$BASE/api/v1/webhooks/meta/whatsapp" -H 'content-type: application/json' -H "x-hub-signature-256: $SIG" -d "$PAYLOAD" 2>/dev/null) || RESP='{"status":"post_failed"}'
  sleep 3
  CONV_ID=$(api GET /api/v1/conversations support_agent "$TENANT_ID" | jq -r '.items[0].id // empty')
  [[ -n "$CONV_ID" ]] && break
  echo "attempt $i: webhook=$(jq -r '.upstream.inbound // .status' <<<"$RESP"), no conversation yet"
done
[[ -n "$CONV_ID" ]] || fail "no conversation after 15 webhook attempts — check: docker compose logs notification-worker webhook-ingestor"
echo "conversation $CONV_ID created from inbound webhook"

step "agent reply + history"
api POST "/api/v1/conversations/$CONV_ID/messages" support_agent "$TENANT_ID" '{"kind":"text","text":"Thanks for reaching out!"}' |
  jq -e '.status == "message_enqueued"' >/dev/null || fail "agent reply"
HIST=$(api GET "/api/v1/conversations/$CONV_ID/messages" support_agent "$TENANT_ID")
echo "$HIST" | jq -e '.items[] | select(.direction=="inbound" and .payload.text=="hello there")' >/dev/null ||
  fail "inbound message missing from history: $HIST"
echo "history contains the inbound message (text lives under .payload.text)"

step "analytics + audit"
api GET /api/v1/analytics analyst "$TENANT_ID" | jq -e '.totals.contacts >= 1' >/dev/null || fail "analytics"
api GET /api/v1/audit compliance_auditor "$TENANT_ID" | jq -e '.items | map(.action) | index("consent.granted") != null' >/dev/null || fail "audit"
echo "analytics + audit OK"

step "SSE stream probe"
SSE=$(curl -isN --max-time 4 "$BASE/api/v1/events/stream" -H 'x-role: support_agent' -H "x-tenant-id: $TENANT_ID" 2>/dev/null | head -12 || true)
{ grep -q "200 OK" <<<"$SSE" && grep -q "text/event-stream" <<<"$SSE"; } || fail "SSE stream: $SSE"
echo "SSE OK"

echo
echo "SMOKE PASS — tenant $TENANT_ID"
