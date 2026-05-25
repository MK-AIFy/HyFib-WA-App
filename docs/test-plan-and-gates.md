# Test Plan and Go-Live Gates

## Functional

- Multi-tenant isolation: tenant A cannot read/modify tenant B records.
- Role enforcement: each endpoint validates `x-role` against allowed actions.
- Template lifecycle: creation, category checks, dispatch block on mismatch.
- Campaign flow: create -> policy validate -> dispatch -> status updates.
- Commerce flow: order events can trigger campaign orchestration.

## WhatsApp Integration

- Webhook verify challenge passes exactly once with matching token.
- Signature validation blocks modified payloads.
- Idempotency blocks duplicate webhook events.
- Number registration and subscribed app workflows succeed.

## Compliance

- Missing consent blocks business-initiated messages.
- Opt-out blocks sends immediately.
- Quiet-hour and frequency-cap policy checks are enforced.

## Reliability

- Retry and replay of webhook payloads do not create duplicate outcomes.
- Notification worker dispatch is idempotent for same campaign/contact tuple.
- Event handling remains deterministic when upstream dependencies fail.

## Security

- Webhook HMAC validation uses `X-Hub-Signature-256` with timing-safe compare.
- Secrets are runtime-only via env/Vault integration pattern.
- Audit log contains actor, tenant, action, and timestamp.
- Database row-level tenant policies are enabled for tenant tables.

## Performance Baseline Targets

- Webhook processing acknowledgement: < 500ms p95 (excluding upstream delays).
- Campaign dispatch API response: < 1s p95 for accepted path.
- Portal API read routes: < 300ms p95 for in-memory baseline.

## Go-Live Gates

- `pnpm build` passes for all packages and services.
- Compose configuration validates (`docker compose config`).
- Security review of `.env` and secret-injection path completed.
- Dry run of number onboarding completed end-to-end in staging.
- DR drill runbook reviewed and approved.
