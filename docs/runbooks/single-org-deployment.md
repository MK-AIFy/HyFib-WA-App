# Single-Organization Deployment

This deployment (2026-07 single-org hardening) serves exactly **one**
organization. Multi-tenant self-service (self-registration, a tenants
console) has been deliberately removed from the external API surface.

## Org resolution (at api-gateway/app-server boot)

`resolveOrgTenant()` (`services/api-gateway/src/single-org.ts`) runs once
during `bootstrapPlatformAdmin()` and picks the tenant row this deployment
serves:

1. **`ORG_TENANT_ID` env var set** → must resolve via `getTenantById`, or
   boot throws (`ORG_TENANT_ID=<id> not found in tenants table`).
2. **Not set** → the `tenants` table must contain exactly one row with
   `status = 'active'`; that row is used. Fresh installs get exactly one via
   the seeded row `00000000-0000-0000-0000-000000000001`
   (`infra/postgres/init/013_auth.sql`).
3. **Zero or more than one active row, and no `ORG_TENANT_ID`** → boot
   throws (`expected exactly one tenant, found N; set ORG_TENANT_ID`) rather
   than guess. Fail fast, don't run ambiguously.

If `ORG_NAME` is also set and differs from the resolved tenant's current
name, the tenant is renamed at boot (rename-at-bootstrap) — useful for
labeling the org without a UI.

## Creating users (no self-registration)

`POST /auth/register` now returns `410 registration_disabled`.

- **First admin**: set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.
  On boot, if no user exists with that email, api-gateway creates a
  `platform_owner` account for the resolved org. No password hash is ever
  committed to source control.
- **Everyone after that**: an existing `platform_owner`/`tenant_admin` calls
  `POST /api/v1/users` (email, displayName, roles) — this is the invite
  flow. The response includes a generated `tempPassword` the admin shares
  with the invitee out-of-band.

## Verifying you have exactly one tenant

Run against the app database:

```sql
SELECT id, name, status FROM tenants;
```

If this returns more than one row (e.g. a stray tenant left over from
before this hardening, or a bad migration), boot will fail loudly rather
than pick one arbitrarily. Remediate by pinning the intended row explicitly:

```
ORG_TENANT_ID=<the-id-you-want>
```

(Alternatively, set the stray rows' `status` to something other than
`'active'` so only one active row remains — but pinning via `ORG_TENANT_ID`
is the recommended fix since it's explicit and survives future stray rows.)

## Not a multi-tenant feature

The schema still has `tenant_id` columns on every tenant-scoped table, and
row-level security (RLS) policies keyed on `app.tenant_id` are still
enforced (the app connects as the non-superuser role `hyfib_app`). This is
kept **by design** as internal defense-in-depth — a bug that forgets a
tenant filter still can't leak data across rows — not as a stepping stone
back to multi-tenancy. The tenants console (`GET/POST /api/v1/tenants`,
`PATCH /api/v1/tenants/:id`, `GET /api/v1/tenants/:id/users`) is removed
from the external API and returns `404`.
