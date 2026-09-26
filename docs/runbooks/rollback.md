# Runbook: Deploying safely and rolling back

Applies to the single-VM deployment (`deploy/oracle`). For rebuilding from nothing, see the
[disaster-recovery drill](dr-drill.md).

## What every deploy does

`deploy/oracle/deploy.sh` runs these steps in order, and stops at the first one that fails:

1. **Checks the new build's config.** `/etc/hyfib/hyfib.env` is checked against the new build's config schema
   before the database is touched.
2. **Backs up the database when any migration is pending.** It runs `scripts/migrate.sh --backup-first`, which
   calls `scripts/backup.sh` with the daily backup timer's settings (`/var/backups/hyfib`, and
   `/etc/hyfib/backup.env` if present). If the backup fails, **nothing is migrated**.
3. **Applies the migrations.** Each migration statement waits at most `MIGRATE_LOCK_TIMEOUT` (default `5s`) for a
   lock. If it can't get the lock in time it fails, instead of stalling every app query on that table behind it.
4. **Installs and restarts the app**, then waits for `/health` to pass.
5. **Records the deploy**, but only once the app is healthy, as one line in `/var/lib/hyfib/deploys.log`:

   ```
   2026-09-25T10:30:00Z version=<commit>[+uncommitted] migrations=<files applied, or none> backup=<pre-migration dump, or none>
   ```

   `+uncommitted` means the deploy was made from a working tree with uncommitted changes, so git alone can't
   reproduce it.

## What is running now

```
sudo tail -n 5 /var/lib/hyfib/deploys.log
```

- **The last line** is what's running.
- **The line before it** is the previous good deploy, which is what you roll back to.

The first deploy made with this version of `deploy.sh` creates the log.

## Choose: redeploy the old code, or restore the database

- **App-only rollback (the usual case).** The new code misbehaves, but the data is fine. Redeploy the previous
  version. Migrations only move forward and must keep working with the previous release's code (every migration so
  far only adds), so the database stays as it is.
- **Database restore (only if data was damaged).** A migration or the new code damaged data. Restore the backup
  taken before that deploy's migrations. **Everything written since that backup is lost**, unless you recover it by
  hand from the extra backup taken in step 2 below.

## App-only rollback

On your machine, from the repo:

```
git fetch origin
git switch --detach <version from the previous line of deploys.log>
deploy/oracle/deploy.sh <ssh-target> <domain>
git switch -
```

The redeploy has no pending migrations, so it takes no backup and changes nothing in the database. It adds its own
line to `deploys.log`.

## Database restore

1. Stop the app: `sudo systemctl stop hyfib-app`
2. Back up the current state first, so nothing is lost for good: `sudo systemctl start hyfib-backup`. Check it
   worked with `journalctl -u hyfib-backup -n 20`.
3. Restore the backup named in the bad deploy's `backup=` field:

   ```
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh <dump>"
   ```

   It checks the dump's checksum. It exits 3 if the configured `CHANNEL_ENCRYPTION_KEY` can't decrypt the restored
   channel tokens; see [DR-critical secrets](dr-drill.md#dr-critical-secrets).
4. Redeploy the version that matches the restored database. That's the deploy **before** the one whose backup you
   restored: follow [App-only rollback](#app-only-rollback). The installed code is still the newer version. Don't
   redeploy that one: it would re-apply the migrations you just rolled back.
5. Tell users that anything written between that backup and the restore is gone. The backup from step 2 still has
   it, if something must be recovered by hand.

## When a deploy stops partway

A deploy that stops before the restart leaves the **old app running**, and it isn't recorded in `deploys.log`. The
deploy output, and `~/hyfib-last-migrate.log` on the VM, show how far it got, including the path of any backup it
took (`backup: done: …`).

- **`ERROR: /etc/hyfib/hyfib.env is missing variables`**: nothing has changed. Add the variable (`sudo`), then run
  the deploy again.
- **The backup failed**, for example because shipping it off the VM (`BACKUP_REMOTE_CMD`) failed: nothing was
  migrated. Fix it, or for this one deploy comment out `BACKUP_REMOTE_CMD` in `/etc/hyfib/backup.env`. The copy
  kept on the VM is enough to roll back from.
- **`canceling statement due to lock timeout`**: another session held a lock on that table for longer than
  `MIGRATE_LOCK_TIMEOUT`. The migration wasn't recorded, so the next deploy retries it. To find what held the lock:

  ```
  sudo -u postgres psql hyfib_wa -c "SELECT pid, state, now() - xact_start AS open_for, left(query, 80) FROM pg_stat_activity WHERE datname = 'hyfib_wa' AND state <> 'idle' ORDER BY xact_start;"
  ```

  Then run the deploy again at a quieter moment. Or allow a longer wait by adding `MIGRATE_LOCK_TIMEOUT=30s` to
  `/etc/hyfib/migrate.env`; the deploy reads it from there.
- **Any other migration error**: the file isn't recorded, but the statements that ran before the error have taken
  effect. Migrations aren't wrapped in a transaction, because `CREATE INDEX CONCURRENTLY` can't run in one. So
  **every migration must be safe to run again from the top**: use `IF NOT EXISTS`, `CREATE OR REPLACE`, or a
  guarded `DO` block. Fix it and run the deploy again. If data was affected, restore the backup it took (above).

## When the app is unhealthy after the restart

`deploy.sh` exits 1 and records nothing. The new code is installed but not healthy, so do an
[app-only rollback](#app-only-rollback) to the last line of `deploys.log`. If that deploy also ran migrations, its
output shows the backup it took, in case you also need a [database restore](#database-restore).
