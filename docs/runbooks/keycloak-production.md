# Runbook: Keycloak Production Mode

The production overlay (`docker-compose.prod.yml`) runs Keycloak with
`start --optimized --import-realm` (not `start-dev`).

## Prerequisites

- `KEYCLOAK_PUBLIC_HOSTNAME` set to the external auth hostname (e.g. `auth.example.com`).
- The edge proxy terminates TLS and forwards to Keycloak; `KC_PROXY_HEADERS=xforwarded`
  and `KC_HTTP_ENABLED=true` are set so Keycloak trusts `X-Forwarded-*`.
- Postgres reachable (`KC_DB_*` from `.env`).

## Bring-up

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d keycloak
```

The `hyfib-wa` realm (roles + the `hyfib-platform` client with `tenant_id` and
audience mappers) is imported from `infra/keycloak/realm-export.json`.

## Post-install hardening

1. Change the bootstrap admin password; create a named break-glass admin; disable
   the default admin if policy requires.
2. Set realm token lifespans (short access tokens, rotating refresh tokens).
3. Configure brute-force detection, password policy, and required actions (MFA).
4. Create users and set the **`tenant_id`** user attribute — the gateway reads it
   from the verified JWT to scope all data access.
5. Assign realm roles (`platform_owner`, `tenant_admin`, `marketing_manager`, …).

## Obtaining a token (service / testing)

```bash
curl -s -X POST \
  "https://$KEYCLOAK_PUBLIC_HOSTNAME/realms/hyfib-wa/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=hyfib-platform \
  -d username=<user> -d password=<pass> | jq -r .access_token
```

Send it to the gateway as `Authorization: Bearer <token>`.
