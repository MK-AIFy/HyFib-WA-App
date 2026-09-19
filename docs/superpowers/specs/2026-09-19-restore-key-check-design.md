# Restore-time Channel-Key Verification (Readiness Blocker 2) — Design

**Date:** 2026-09-19
**Parent:** production-readiness audit of `main @ fca00db` (2026-09-19), blocker 2 —
"backups don't cover the channel-token encryption key".
**Problem:** After a disaster-recovery restore onto a replacement VM, nothing tells the
operator that the restored channel tokens can no longer be decrypted. `restore.sh` prints
migration/tenant/RLS evidence only, and the DR runbook never mentions the key.

## Verified facts (2026-09-19)

- `CHANNEL_ENCRYPTION_KEY` protects exactly one thing: `whatsapp_channels.access_token_encrypted`
  (AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>`). The only encrypt/decrypt call sites are in
  `packages/persistence/src/repositories.ts` (`encryptChannelToken` on channel create and update,
  `mapChannelCredentials` on read). The other `*_encrypted` columns from migration 007 are not
  referenced by any code.
- The key exists only in `/etc/hyfib/hyfib.env`. `deploy/oracle/setup-vm.sh` writes that file only
  if it is missing and generates a fresh random key (`gen 32`), so a replacement VM has a
  different key from the one that encrypted the restored tokens.
- `scripts/backup.sh` dumps the database only; `scripts/restore.sh` never looks at the key;
  `docs/runbooks/dr-drill.md` does not mention it.
- Effect of a wrong key after restore: every outbound send through an affected channel fails
  loudly (`outbound_send_failed`); inbound processing continues (commit `76ac29b`). It is
  recoverable — an admin re-enters the channel token through the API only
  (`PATCH /api/v1/channels/whatsapp/:id {"accessToken": …}`, `platform_owner`/`tenant_admin`; the UI's
  onboarding page only _creates_ a channel and Settings only lists them),
  which re-encrypts it under the current key. No contact or message data is lost.
- `deploy.sh` builds on the VM and rsyncs the whole tree (every `dist/` and `scripts/`) to
  `/opt/hyfib/app`, so `packages/shared-core/dist` sits next to `scripts/restore.sh` in
  production. `deploy.sh` already imports `packages/config/dist` by path for its pre-restart
  config check.
- `whatsapp_channels` is `FORCE ROW LEVEL SECURITY` (`001_schema.sql`): a role that does not
  bypass RLS reads zero rows **without an error**.

## Decision

**Detect and document; do not move secrets.** Putting the key (or `hyfib.env`) into the backup
directory or the off-host dump defeats the encryption — a leaked backup would then decrypt every
channel token.

Rejected alternatives:

- _Automated escrow_ (encrypt the key to an operator-supplied age/GPG recipient and ship it with
  the dump): adds a crypto dependency, more code that handles plaintext secrets, and a recipient
  private key to safeguard — it moves the problem instead of removing it.
- _Docs only_: a wrong or missing key after restore would stay silent until sends fail.

## Scope

1. `scripts/check-channel-key.mjs` — new checker.
2. `scripts/verify-channel-key.sh` — new thin wrapper (resolve the key, RLS guard, read the
   tokens, run the checker) that also runs on its own; `scripts/restore.sh` runs it after the
   existing evidence block.
3. Runbook and README updates.
4. Root `package.json` `test` also runs the scripts tests.

Out of scope (separate decisions or later iterations): off-host backup policy and the RPO
objective; automated escrow; key-rotation tooling; proactive daily verification from
`backup.sh`; a CI drill step against a real database (worth adding once this lands).

## 1. `scripts/check-channel-key.mjs`

Input: lines of `<channel-id>\t<encrypted-token>` on stdin. Key: the `CHANNEL_ENCRYPTION_KEY`
environment variable only — never argv, never printed.

- Imports `encryptSecret`/`decryptSecret` from `../packages/shared-core/dist/index.js`, so the
  check uses the exact production code path and cannot drift from it.
- Exports `verifyChannelTokens(rows, key, { decrypt })` — pure, with decrypt injected — returning
  `{ total, ok, failed: [{ id, reason }] }`. `reason` is one of the fixed strings
  `authentication failed` (GCM auth error), `malformed` (not `v1:` format) or `error`. Raw error
  text and decrypted values are never returned.
- Key usability is proven by a probe (`encryptSecret("probe", key)`) rather than by
  re-implementing key decoding.
- The CLI entry, guarded by the same `import.meta.url` entrypoint check the services use, prints

  ```
  channel tokens decryptable: 1/2
  FAILED  <channel-id>  authentication failed
  ```

  or `no channel tokens stored — nothing to verify` when the input is empty.

- Exit codes: `0` all decryptable, or none stored; `1` at least one failed; `2` unusable key or
  usage error.

## 2. `scripts/verify-channel-key.sh` and `scripts/restore.sh`

`verify-channel-key.sh [db]` (default `$POSTGRES_DB`; the same `POSTGRES_*` credentials as
`restore.sh`) does the following:

1. **Resolve the key:** `$CHANNEL_ENCRYPTION_KEY` if set; otherwise the value of the single
   `CHANNEL_ENCRYPTION_KEY=` line in `${HYFIB_ENV_FILE:-/etc/hyfib/hyfib.env}` if readable. Only
   that one variable is extracted — the file is never sourced. Surrounding whitespace and
   matching quotes are stripped.
2. **No key** → `NOTE: CHANNEL_ENCRYPTION_KEY not available — channel tokens NOT verified`, with the
   command to run the check later. Continue; exit 0.
3. **No `node`, or `packages/shared-core/dist/index.js` missing** → `WARNING: cannot verify …`.
   Continue; exit 0.
4. **RLS guard:** `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`
   must return `t`; otherwise `WARNING: role is subject to RLS — channel tokens NOT verified`.
   This stops the silent zero-rows result from producing a false "OK".
5. `psql -At -F<TAB>` selects `id, access_token_encrypted` from `whatsapp_channels` where the
   token is not null (ordered by id) and pipes the rows to the checker, which receives the key
   in its environment.
6. **Exit mapping:** checker `0` → continue, exit 0; checker `1` or `2` → print the ERROR block
   and **exit 3** ("database restored, environment not fully recovered").

ERROR block (channel ids only, no secrets):

```
ERROR: <n> of <m> stored channel tokens cannot be decrypted with the configured CHANNEL_ENCRYPTION_KEY.
The database is restored, but outbound sends on those channels fail until ONE of:
  (a) the ORIGINAL CHANNEL_ENCRYPTION_KEY (from your secrets escrow) is put into
      /etc/hyfib/hyfib.env and hyfib-app is restarted, or
  (b) each channel's access token is re-entered (API only: PATCH /api/v1/channels/whatsapp/<id>
      {"accessToken": …}); it is re-encrypted under the current key.
See docs/runbooks/dr-drill.md, "DR-critical secrets".
```

There is no override flag: a non-zero exit is the point — DR drills must go red.

**`restore.sh` integration.** The restore and the existing evidence output are unchanged and
complete first. `restore.sh` then runs `verify-channel-key.sh "$target"`, still prints its final
`done`, and exits with the wrapper's status (`0` or `3`). The wrapper also runs standalone — after a
config change, or as part of a drill:

```
sudo bash -c 'set -a; . /etc/hyfib/migrate.env; set +a; bash /opt/hyfib/app/scripts/verify-channel-key.sh'
```

and the NOTE in step 2 prints exactly that command. (Re-running `restore.sh` is not an option
for a later check: it would drop the database.)

**Backward compatibility.** The CI `backup-restore-drill` job and the README restore command run
without the key in the environment and without `/etc/hyfib/hyfib.env` on the runner, so they take
the NOTE path and are unaffected. The only new failure mode is one that was previously silent.

## 3. Docs

`docs/runbooks/dr-drill.md`:

- New section **DR-critical secrets**: what the key protects; escrow `hyfib.env` in the
  organisation's secrets manager, separately from `/var/backups/hyfib` and from wherever
  `BACKUP_REMOTE_CMD` ships dumps; put the original key in place _before_ starting the app on a
  replacement VM (`setup-vm.sh` generates a new one); if the key is lost, re-enter each channel
  token — nothing else is lost (API only: `PATCH /api/v1/channels/whatsapp/<id>`, using a Bearer token
  from `POST /auth/login`; there is no UI for editing an existing channel's token yet).
- The drill procedure gains a step and an evidence line (`channel tokens decryptable: N/N`).
- Stale items that would mislead someone mid-disaster are corrected to the current topology
  (PostgreSQL, Redis and the env file; no Vault, RabbitMQ, MinIO or Keycloak), and the off-host
  default is stated plainly: dumps stay on the VM until `BACKUP_REMOTE_CMD` is set. This
  documents the fact only — the policy decision is a separate follow-up.

`deploy/oracle/README.md`: one pointer from the DB-restore row and the secrets row to that section.

## Security considerations

- The key travels only in an environment variable to one child process — never argv (visible in
  `ps`), never logged.
- The pipe between `psql` and the checker carries ciphertext only.
- `hyfib.env` is read for one variable, not sourced, so no other secret enters the restore
  process environment.
- The checker is read-only; its output exposes channel ids and fixed reason strings only.
- Explicit non-goal: nothing is added to backup artifacts.

## Testing

`scripts/test/check-channel-key.test.mjs`, run by `node --test`, fixtures produced by the real
`encryptSecret`:

- **Unit:** right key; wrong key; malformed payload; mixed set (counts and ids correct); empty
  input; unusable key; and the returned structure and CLI output never contain a plaintext token
  or the key.
- **CLI:** spawn the script with stdin, assert exit codes `0`/`1`/`2` and no leaked secrets.
- **Wiring:** root `package.json` `test` becomes `pnpm -r test && node --test "scripts/test/*.test.mjs"`,
  so the existing CI unit-test step runs them.

Live end-to-end (local; a throwaway `postgres:16-alpine` on a random port; nothing else touched):
migrate → seed a channel with a real encrypted token → `backup.sh` → `restore.sh` with the right
key (exit 0, `1/1`), a wrong key (exit 3, database still restored) and no key (NOTE, exit 0); then
`verify-channel-key.sh` standalone against the restored database, and the RLS guard against a
role that does not bypass RLS.

## Iterations and commits (one module each, each gated on build + lint + format + tests)

1. scripts: checker + tests + `restore.sh` + root test wiring.
2. docs: runbook + README.

Follow-ups needing a decision (raised separately): off-host backup policy (warn vs fail when
`BACKUP_REMOTE_CMD` is unset), and the RPO objective (the runbook's example says ≤ 5 minutes;
daily dumps give up to 24 hours).
