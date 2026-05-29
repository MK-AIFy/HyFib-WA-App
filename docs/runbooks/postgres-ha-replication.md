# Runbook: PostgreSQL HA (Streaming Replication)

The base compose defines `postgres-primary`, `postgres-standby`, and
`postgres-replica` as a **reference topology**. Real streaming replication is
environment-specific (storage, network, failover tooling); wire it as follows.

## Primary configuration

In `postgresql.conf` (mount an override or use `command:` flags):

```
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
hot_standby = on
synchronous_commit = on            # for the synchronous standby
synchronous_standby_names = 'standby1'
```

Create a replication role and `pg_hba.conf` entry:

```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '<secret>';
```
```
host replication replicator <standby-cidr> scram-sha-256
```

## Standby / replica bootstrap

```bash
pg_basebackup -h postgres-primary -U replicator -D /var/lib/postgresql/data \
  -Fp -Xs -P -R -S standby1
```

`-R` writes `standby.signal` + `primary_conninfo`. The async `postgres-replica`
omits a synchronous slot and is used for read scaling / reporting.

## Failover

Use Patroni or repmgr for automated leader election + promotion in production;
manual promotion is `pg_ctl promote`. Repoint the app's `POSTGRES_HOST`
(or a virtual IP / PgBouncer) to the new primary.

## Verify

```sql
SELECT client_addr, state, sync_state FROM pg_stat_replication;  -- on primary
SELECT pg_is_in_recovery();                                      -- true on standby
```

## RLS note

The app connects as the non-superuser `hyfib_app` so RLS is enforced; ensure the
role and its grants exist on the promoted primary (they replicate with the data).
