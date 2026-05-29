# Runbook: Disaster Recovery Drill

Validate RPO/RTO objectives with evidence on a scheduled cadence (at least
quarterly).

## Objectives (set per environment)

- RPO: maximum acceptable data loss (e.g. ≤ 5 minutes).
- RTO: maximum acceptable downtime (e.g. ≤ 60 minutes).

## Backups

1. **PostgreSQL**: nightly base backup + continuous WAL archiving to off-host
   storage (e.g. `pgBackRest`/`wal-g`). Verify restore weekly.
2. **RabbitMQ**: durable exchanges/queues + persistent messages survive restart;
   the transactional **outbox** in Postgres is the source of truth for unpublished
   events, so a broker loss does not lose dispatch intent.
3. **Vault**: raft snapshots (`vault operator raft snapshot save`).
4. **MinIO / object store**: bucket replication or scheduled snapshots.
5. **Keycloak**: realm config is in `infra/keycloak/realm-export.json`; user data
   lives in Postgres (covered above).

## Drill procedure

1. Provision a clean environment from infra-as-code + this repo.
2. Restore the latest Postgres backup; replay WAL to the target point in time.
3. Restore the Vault raft snapshot; unseal.
4. Bring up the stack: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
5. Run `scripts/local-runbook-e2e.sh` against the recovered environment.
6. Confirm: tenants/contacts/campaigns present, RLS intact, a test campaign
   dispatches, a simulated webhook persists a message.

## Evidence

Record start/end timestamps (RTO), the last restored transaction vs. incident
time (RPO), and attach `local-runbook-e2e.sh` output. File in the compliance log.
