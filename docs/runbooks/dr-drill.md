# Runbook: Disaster Recovery Drill

Validate RPO/RTO objectives with evidence on a scheduled cadence (at least quarterly). This runbook
describes the current topology — the modular monolith on a single VM (`deploy/oracle/README.md`):
PostgreSQL, Redis, the app-server and Caddy.

## Objectives (set per environment)

- RPO: maximum acceptable data loss. **Today's implementation gives up to about 24 hours**: one dump per
  day at 02:30 UTC plus up to 15 minutes of timer jitter. A tighter RPO needs continuous WAL archiving
  (`pgBackRest`/`wal-g`) on top of the dumps.
- RTO: maximum acceptable downtime (e.g. ≤ 60 minutes).

## What is backed up

1. **PostgreSQL — implemented.** `scripts/backup.sh` produces a verified (`pg_restore --list`)
   custom-format dump with a sha256 checksum and prunes to `BACKUP_RETENTION` local copies (default 14).
   On the production VM the `hyfib-backup.timer` unit (installed by `deploy/oracle/setup-vm.sh`, daily
   02:30 UTC, `Persistent=true`) drives it with credentials from `/etc/hyfib/migrate.env`.
   **Shipping off the host is opt-in:** until `BACKUP_REMOTE_CMD` is set in `/etc/hyfib/backup.env`, the
   dumps exist only on the VM (the run logs a WARNING, yet the timer unit still reports success). A dump
   that never leaves the host is not DR. Once `BACKUP_REMOTE_CMD` is set, its failure fails the run.
   Restore with `scripts/restore.sh <dump>`: it verifies the checksum and integrity, refuses live or
   existing databases without `RESTORE_FORCE=1`, prints migration/tenant/RLS evidence, and verifies the
   channel-token key (see [DR-critical secrets](#dr-critical-secrets)). CI rehearses the cycle on every PR
   (`backup-restore-drill`: migrate → dump → drop → restore → run the persistence suite against the
   restored database). The docker-compose deployment has no backup timer — schedule `scripts/backup.sh`
   yourself there.
2. **Undelivered events.** In this topology there is no message broker (`EVENT_BUS=memory`). The
   transactional **outbox** is a PostgreSQL table, so events not yet delivered are part of the dump.
3. **Redis — not backed up, by design.** It holds only short-lived coordination state (rate-limit counters,
   replay/idempotency claims with expiry, out-of-office suppression). Sessions, the outbox and the campaign
   send log live in PostgreSQL. After a Redis loss the platform recovers on its own; at worst an event that
   was mid-redelivery is processed again.
4. **Secrets — not in the dump, and must not be.** See below.

## DR-critical secrets

A database dump alone does not recover the platform onto a new VM. These values live only in
`/etc/hyfib/hyfib.env` (root-only) and are in no backup:

| Secret | What it protects | If lost |
| --- | --- | --- |
| `CHANNEL_ENCRYPTION_KEY` | AES-256-GCM encryption of each WhatsApp channel's access token (`whatsapp_channels.access_token_encrypted`) — the only thing it encrypts | The restored tokens cannot be decrypted: outbound sends on those channels fail until each token is re-entered. No contact, message or campaign data is lost. |
| `META_APP_SECRET` | Verifying Meta webhook signatures | Re-copy it from the Meta app dashboard. |
| `WEBHOOK_VERIFY_TOKEN` | Meta's webhook subscription handshake | Use the value configured in the Meta webhook settings (or update Meta to the new one). |

Rules:

1. **Escrow `CHANNEL_ENCRYPTION_KEY`** in the organisation's secrets manager or password vault —
   **separately from `/var/backups/hyfib` and from wherever `BACKUP_REMOTE_CMD` ships dumps.** Never keep the
   key next to a dump: a leaked backup would then decrypt every channel token, which is exactly what the
   encryption is for.
2. `setup-vm.sh` writes `hyfib.env` only if it is missing and generates a **new random key**, so a
   replacement VM does not have the original one.
3. After restoring onto a replacement VM, put the original key into `/etc/hyfib/hyfib.env` (edit only that
   line) and run `sudo systemctl restart hyfib-app`. `restore.sh` — and `scripts/verify-channel-key.sh` on
   its own — reports whether the configured key decrypts the restored tokens: **exit status 3 means it
   does not.** A missing key or a role that cannot read the tokens only prints a NOTE/WARNING (tokens not
   verified) and leaves the status at 0.
4. If the key is truly lost, re-enter each channel's access token. This is **API-only** today: the
   onboarding page only creates a channel and Settings only lists them. You need an admin
   (`platform_owner` or `tenant_admin`) Bearer token:

   ```sh
   # 1. log in; the JSON reply contains "token"
   curl -sS -X POST https://<domain>/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"<admin email>","password":"<admin password>"}'
   export TOKEN=<the token value from the reply>

   # 2. list the channels (ids), then re-enter the token for each failing one
   curl -sS -H "Authorization: Bearer $TOKEN" https://<domain>/api/v1/channels/whatsapp
   curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"accessToken":"<token from Meta>"}' https://<domain>/api/v1/channels/whatsapp/<channel-id>
   ```

   The token is re-encrypted under the current key. Issue a fresh token in Meta if the old value is
   unavailable.

## Drill procedure (single VM, `deploy/oracle`)

1. Provision a clean VM and deploy: `deploy/oracle/deploy.sh ubuntu@<ip> <domain>`. This generates NEW
   secrets in `/etc/hyfib/hyfib.env`.
2. Copy the latest dump (from the off-host location) to `/var/backups/hyfib/` on the VM.
3. Stop the app: `sudo systemctl stop hyfib-app`.
4. Restore:

   ```sh
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh /var/backups/hyfib/<dump>"
   ```

   Expect the migration/tenant/RLS evidence and `channel tokens decryptable: N/N`. If it ends with an
   ERROR and exit status 3, the key on this VM is not the one that encrypted the tokens: put the escrowed
   `CHANNEL_ENCRYPTION_KEY` into `/etc/hyfib/hyfib.env` and re-check with:

   ```sh
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; bash /opt/hyfib/app/scripts/verify-channel-key.sh"
   ```

5. Start the app: `sudo systemctl start hyfib-app`, then check `https://<domain>/health`.
6. Log in with the restored users' credentials — the new VM's `/etc/hyfib/ADMIN_CREDENTIALS` only bootstraps
   an admin that does not exist yet. Confirm tenants, contacts and campaigns are present, a simulated
   webhook persists a message, and a test send through a channel is accepted. Do **not** run
   `scripts/local-runbook-e2e.sh` against the VM: it is a local/dev script (it starts the docker-compose
   stack and needs `AUTH_ENABLED=false`).

## Evidence

Record start/end timestamps (RTO), the last restored transaction vs. incident time (RPO), the
`channel tokens decryptable: N/N` line, and attach the smoke-test output. File it in the compliance log.
