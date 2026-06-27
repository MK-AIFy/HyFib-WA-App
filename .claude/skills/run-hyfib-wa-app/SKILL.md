---
name: run-hyfib-wa-app
description: Build, run, and drive the HyFib WhatsApp Business platform locally. Use when asked to start or run the app/stack, smoke-test it, exercise the API (tenants, campaigns, webhooks, conversations), or verify a change against the running system.
---

Multi-service WhatsApp Business platform (Node/TS monorepo) orchestrated by Docker Compose: nginx edge, api-gateway, web-portal, meta-adapter, webhook-ingestor, notification-worker, ai-intelligence-service, plus Postgres/Redis/RabbitMQ/Keycloak/MinIO/OpenSearch/Vault/Prometheus/Grafana. Drive it with the smoke driver at `.claude/skills/run-hyfib-wa-app/smoke.sh` — it bootstraps `.env`, brings the stack up, and exercises one full tenant→campaign→webhook→conversation flow with assertions. No real Meta credentials needed.

All paths are relative to the repo root.

## Prerequisites

Docker daemon running (verified with Docker 29.5.3 on macOS), plus `curl`, `jq`, `openssl` on the host. The driver checks all four and fails fast if one is missing.

## Run (agent path)

One command — builds images on first run (several minutes; warm runs ~30s), waits for the DB-backed gateway health, then drives the API end-to-end:

```bash
.claude/skills/run-hyfib-wa-app/smoke.sh
```

Ends with `SMOKE PASS — tenant <uuid>` and exit 0, or `SMOKE FAIL: <step>` and exit 1.

What it asserts, in order: gateway `/health` reports `database: true`; portal and HTTPS edge health; tenant/user creation; channel registration with dummy ids; `analyst` role gets 403 on `POST /contacts` (role-gate check); contact+consent; template (auto-approved via direct DB update — see Gotchas); campaign dispatch returns `dispatch_enqueued`; an HMAC-signed inbound webhook is ingested (`inbound: 1`); a conversation appears with the inbound message in history; agent reply returns `message_enqueued`; analytics and audit reflect the run; `GET /api/v1/events/stream` serves `200 text/event-stream`.

Variants:

```bash
SKIP_COMPOSE_UP=1 .claude/skills/run-hyfib-wa-app/smoke.sh   # stack already running
.claude/skills/run-hyfib-wa-app/smoke.sh --bootstrap-env-only /tmp/test.env  # just generate an env file
```

Ad-hoc API calls against the running stack use header identity (only valid because `.env` sets `AUTH_ENABLED=false`):

```bash
curl -fsS http://localhost:18080/api/v1/conversations \
  -H 'x-role: support_agent' -H "x-tenant-id: <tenant-uuid>" | jq .
```

Roles: `platform_owner`, `tenant_admin`, `marketing_manager`, `sales_agent`, `support_agent`, `analyst`, `compliance_auditor`.

## Run (human path)

```bash
docker compose up --build -d
docker compose ps        # 22 containers, app services report (healthy)
```

| Surface | URL |
|---|---|
| Web portal (via TLS edge, self-signed) | https://localhost |
| api-gateway (direct) | http://localhost:18080 |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| RabbitMQ console | http://localhost:15672 |
| MinIO console | http://localhost:9001 |
| Keycloak | http://localhost:8081 |

Stop with `docker compose down` (keeps data volumes) or `docker compose down -v` (wipes them — required if you regenerate `.env`).

## Test

Unit tests run against compiled `dist/`, so install + build first:

```bash
pnpm install && pnpm -r build && pnpm -r test
```

All suites pass; `packages/persistence` skips its 4 DB integration tests unless a live database is configured.

## Gotchas

- **`.env` regeneration invalidates the Postgres volume.** The init scripts bake `POSTGRES_*` passwords into the volume on first boot. New `.env` + old volume = DB auth failures. Run `docker compose down -v` first. The driver warns when it detects this.
- **No real Meta credentials ⇒ outbound sends fail by design.** Dispatch and agent replies return 202 and enqueue fine, then notification-worker logs `dispatch_failed ... meta_adapter_rejected_503`. Everything before and after the Graph call works. `scripts/local-runbook-e2e.sh` step 5 (subscribe/register number) hard-requires real `WHATSAPP_WABA_ID`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_REGISTER_PIN`; the smoke driver registers a dummy channel instead.
- **Templates are created `pending` and can't be dispatched.** Meta approval is asynchronous in real environments; locally, approve via direct DB update (the driver does this): `docker compose exec -T postgres-primary psql -U platform -d hyfib_wa -c "UPDATE templates SET status='approved' WHERE id='<id>';"`
- **A webhook 200 proves publish, not consumption.** Events go ingestor → RabbitMQ default exchange (no mandatory flag) → notification-worker. On a cold start, anything published before the worker has asserted its queues is **silently dropped** — the ingestor still logs `webhook_ingested inbound:1`. The driver therefore resends webhooks (fresh message id each time) until a conversation actually appears.
- **The gateway records webhook idempotency even when its upstream call fails.** Retrying a byte-identical payload after a 500 returns `{"status":"duplicate_ignored"}` and never ingests it. Always retry with a fresh `wamid`.
- **`rabbitmq-diagnostics ping` lies about readiness.** It passes while the AMQP listener still refuses connections (services crash with `ECONNREFUSED :5672` after a green ping). Gate on `rabbitmq-diagnostics -q check_port_connectivity` instead.
- **Cold starts take ~60–90s to settle even after health checks pass.** The ingestor dies on an unhandled AMQP rejection and is docker-restarted; the gateway outbox relay and worker reconnect with exponential backoff (up to 30s), so first dispatch consumption and first inbound persistence lag accordingly. The driver absorbs all of this; ad-hoc manual testing right after `up` will hit it.
- **Message text lives at `.payload.text` in history responses,** not a top-level `text` field. `jq '.items[].text'` silently returns nulls.
- **Use a fresh `phoneNumberId` per run.** Inbound webhooks route to tenants by `phone_number_id`; reusing one across runs sends events to the oldest matching channel. The driver derives one from the timestamp.
- **Redis sentinels need the compose substitution shim.** The committed `infra/redis/sentinel.conf` uses a `__REDIS_PASSWORD__` placeholder and `sentinel resolve-hostnames yes`; docker-compose copies it to a writable path and substitutes the password at start. Don't "simplify" the sentinel `command:` back to running the read-only mounted file — sentinel must rewrite its config at runtime and dies otherwise.
- **HTTP on the edge 301s to HTTPS,** and the local cert is self-signed — use `curl -k https://localhost/...`.

## Troubleshooting

- **Sentinels crash-loop with `*** FATAL CONFIG FILE ERROR ... Can't resolve instance hostname`**: `sentinel resolve-hostnames yes` is missing from `infra/redis/sentinel.conf` (it must be the first sentinel directive) — see Gotchas above.
- **`tsc` build errors like `Module '"@hyfib/auth"' has no exported member 'hasAnyRole'`**: stale committed `dist/` in workspace packages; run `pnpm -r build` (topological) instead of building one package.
- **`error TS2307: Cannot find module 'jose'`**: dependencies declared but not installed — run `pnpm install` at the repo root.
- **Webhook POST returns 500 (`request_failed ... fetch failed` in gateway logs)**: the ingestor isn't listening yet (crash-looping on broker connect). Wait and retry **with a fresh message id** (see idempotency gotcha).
- **Webhook accepted (`inbound: 1`) but no conversation/message ever appears**: the event was published before the worker's consumer existed and was dropped. Resend once `docker compose logs notification-worker` shows activity (e.g. a consumed dispatch), or just run the smoke driver, which loops until consumption is proven.
- **`Error: connect ECONNREFUSED <ip>:5672` + repeated `service_started` in ingestor/worker logs**: normal during the first ~60s after a cold `compose up`; docker restarts them until RabbitMQ accepts connections.
- **Gateway health hangs or `database: false`**: check `docker compose logs api-gateway postgres-primary`; if Postgres logs show password authentication failures, the `.env`/volume mismatch above is the cause.
