# Operational Gaps and Next Hardening Actions

This implementation provides a production-grade foundation, but these items must be completed before true internet production.

## 0) Resolved in the foundation hardening iteration

- **Real persistence**: the api-gateway now stores all tenant data in PostgreSQL
  via `@hyfib/persistence` (no more in-memory maps; survives restarts).
- **Row-level security enforced**: the app connects as the non-superuser role
  `hyfib_app` and sets `app.tenant_id` per transaction, activating the schema's
  RLS policies. Created by `infra/postgres/init/002_app_role.sh`.
- **Real authentication**: `@hyfib/auth` verifies Keycloak JWTs (signature,
  issuer, audience, expiry) and derives tenant + roles from claims. Header trust
  is removed unless `AUTH_ENABLED=false` (dev only). Keycloak realm now imports a
  `hyfib-platform` client with `tenant_id` + audience mappers.
- **Edge TLS + security headers**: nginx terminates TLS, redirects HTTP→HTTPS,
  sends HSTS/CSP/X-Frame-Options/nosniff, and hides version (`server_tokens off`).
- **Secret hygiene**: config fails fast in production when secrets are unset or
  left at placeholder values; gateway responses set `Cache-Control: no-store`.
- **Topology consolidation**: nine empty stub services and the redundant
  campaign-service were removed; dispatch logic folded into the gateway.
- **Container healthchecks** added to every service Dockerfile and to compose.
- **Baseline tests** added (policy engine, webhook signature, role checks).
- **Graceful shutdown**: gateway drains connections and closes the pool on
  SIGTERM/SIGINT.

## 0b) Resolved in the production-completion iteration

- **Durable eventing**: real RabbitMQ transport (durable topic exchange, confirm
  channel, DLX/DLQ, auto-reconnect) replaces the in-memory placeholder, with a
  transactional outbox + relay for atomic, at-least-once delivery.
- **Message lifecycle**: inbound messages and delivery statuses are now consumed
  and persisted (conversations + messages); campaign dispatch is asynchronous
  (202) and idempotent.
- **Observability**: Prometheus `/metrics` on every service.
- **Quality gates**: ESLint + Prettier, expanded unit/integration tests, and a
  hardened CI (frozen lockfile, lint/format, Postgres+RabbitMQ integration job,
  Trivy image scan).
- **Production overlay**: `docker-compose.prod.yml` (Keycloak `start`, Vault
  server mode, OpenSearch security on) plus runbooks under `docs/runbooks/`.
- **Meta resilience**: retry/backoff + circuit breaker around Graph API calls.

## 0c) Resolved in the auth-hardening iteration

- **Database migrations**: `infra/postgres/init/*.sql` only ran once, on first
  cluster initialisation — files added after a database's volume already
  existed (e.g. the auth tables) never reached it. `scripts/migrate.sh`
  (`pnpm migrate`) now tracks applied files in a `schema_migrations` table and
  applies pending ones in order against an existing database; CI's
  integration job runs it instead of hand-picking three files. Run it against
  any environment after pulling new migrations.
- **Native session auth**: `/auth/register`, `/auth/login`, `/auth/logout`,
  `/auth/me` with scrypt password hashing, rate-limited login/register
  (5/min per IP, keyed by email too on login), expired-session purge, and
  session revocation on password change. No password hash is committed to
  source control — the first platform_owner account is created at startup
  from `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` if set and no user
  with that email exists yet.

The items below remain environment-specific and are delivered as configuration
plus runbooks (not turnkey automation), to be completed against the client's
hardware/network.

## 1) Replace Lab Defaults

- Replace Vault dev mode with HA integrated storage and auto-unseal.
- Replace Keycloak `start-dev` with production mode and external DB TLS.
- Enable OpenSearch security plugin and authenticated transport.

## 2) Edge and TLS Hardening

- Add TLS 1.3 certificates and strict cipher suites at edge.
- Enforce Meta webhook source allowlisting with regularly updated CIDRs.
- Add WAF managed rules and DDoS controls at perimeter.

## 3) Queue/Event Transport

- Replace in-memory event fallback with RabbitMQ durable publishers/consumers.
- Add DLQ routing and retry backoff policies per topic.

## 4) Data and Key Management

- Implement tenant-specific envelope encryption keys from Vault transit.
- Add retention jobs, legal hold controls, and immutable audit storage target.

## 5) Runtime Verification

- Run container image scanning (Trivy/Grype) in CI and release gates.
- Run DAST against edge endpoints and webhook abuse scenarios.
- Execute DR drill to validate RPO/RTO objectives with evidence.
