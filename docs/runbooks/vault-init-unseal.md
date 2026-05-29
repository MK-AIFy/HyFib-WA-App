# Runbook: Vault Initialise & Unseal (Production)

The production overlay runs Vault as a real server with raft storage
(`infra/vault/config.hcl`), not dev mode. Secrets are delivered to services by a
Vault Agent that templates them into the `.env` file the containers read — the
application code stays Vault-agnostic.

## 1. Bring up Vault

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d vault
```

## 2. Initialise (once per cluster)

```bash
docker exec -it vault vault operator init -key-shares=5 -key-threshold=3
```

Record the 5 unseal keys and the initial root token in your secrets vault / HSM.
**Never** store them in the repo or on disk.

## 3. Unseal (after every restart, 3 of 5 keys)

```bash
docker exec -it vault vault operator unseal <key-1>
docker exec -it vault vault operator unseal <key-2>
docker exec -it vault vault operator unseal <key-3>
```

Prefer **auto-unseal** with a cloud KMS / HSM (`seal "transit"` or `seal
"awskms"` stanza) in real production so restarts do not require manual keys.

## 4. Enable KV and load secrets

```bash
docker exec -it vault sh -lc '
  export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<root-token>
  vault secrets enable -path=hyfib kv-v2
  vault kv put hyfib/app \
    POSTGRES_PASSWORD=... POSTGRES_APP_PASSWORD=... REDIS_PASSWORD=... \
    META_APP_SECRET=... WEBHOOK_VERIFY_TOKEN=... WHATSAPP_ACCESS_TOKEN=... \
    KEYCLOAK_ADMIN_PASSWORD=... ANTHROPIC_API_KEY=...
  vault policy write hyfib-app /vault/config/policies/app.hcl
'
```

## 5. Vault Agent secret injection (recommended)

Run a Vault Agent (AppRole auth) with a template that renders the KV secrets into
`/run/secrets/app.env`, and point each service's `env_file` at that rendered file.
Rotate the AppRole secret-id on a schedule. This keeps secrets out of images,
the repo, and `docker inspect`.

## 6. Rotation

Rotate KV secrets on a 90-day cycle; re-render the agent template; restart
services with a rolling strategy. Revoke the initial root token after setup.
