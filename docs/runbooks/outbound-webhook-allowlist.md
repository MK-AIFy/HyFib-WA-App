# Runbook: Outbound Webhook Allowlist (`OUTBOUND_WEBHOOK_ALLOWLIST`)

Each tenant's outbound webhook (`whatsapp_settings.status_callback_url`) goes
through the outbound-URL guard (SSRF). It refuses private, loopback,
link-local, reserved and internal-name destinations twice: when an admin saves
the URL (the settings `PUT` returns 400), and on **every delivery** (the
worker). A URL saved before the guard existed that points at such a receiver
therefore **stops receiving webhooks silently** once the guard is deployed. The
tenant sees no error. Only the operator sees it, as a `customer_webhook_blocked`
warn log and in `customer_webhooks_total{result="blocked"}`.

`OUTBOUND_WEBHOOK_ALLOWLIST` is the operator's exception list for a receiver
that is **meant** to be on a private network, such as an on-prem customer
system. You set it in the environment only. Tenants cannot set it, no API
returns it, and the 400 a tenant admin sees never mentions it.

> Not to be confused with `ALLOWED_WEBHOOK_CIDRS`, which is about _inbound_
> Meta webhook sources (see `meta-webhook-cidr-allowlist.md`).

## 1. Before deploying: audit the stored URLs

Run the read-only audit **before** deploying a build that contains the guard,
and again before changing the allowlist. It needs the following:

- **This build's code**: a checkout of the build you are about to deploy, after
  `pnpm install && pnpm build`. The script uses the app's own guard and parser.
- **Database credentials that bypass RLS**: a superuser or a `BYPASSRLS` role
  (`POSTGRES_USER`/`POSTGRES_PASSWORD`; on the Oracle VM that is
  `/etc/hyfib/migrate.env`). `whatsapp_settings` is FORCE-RLS, so the app role
  would read zero rows. The script refuses to run with such a role (exit 2)
  instead of reporting "nothing stored".
- **The app host, for `--resolve`**: `--resolve` resolves each host name the way
  the app would. Run it where the app runs, because a Docker network, a VPN or
  split DNS gives different answers elsewhere.

```bash
# In the new build's checkout, on the app host:
sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; bash scripts/audit-status-callback-urls.sh --resolve"

# To try an allowlist before setting it (an explicit value, even an empty one, overrides hyfib.env):
sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; \
  OUTBOUND_WEBHOOK_ALLOWLIST='hooks.corp,10.1.2.0/24' bash scripts/audit-status-callback-urls.sh --resolve"
```

The script is read-only. Every psql session runs with
`default_transaction_read_only=on` and issues SELECTs only. When
`OUTBOUND_WEBHOOK_ALLOWLIST` is unset, it reads that one variable from
`HYFIB_ENV_FILE` (default `/etc/hyfib/hyfib.env`) and never sources the file.
Its output shows each tenant's verdict and only `scheme://host[:port]`, never
the path, query or signing secret.

| Verdict               | Meaning                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED`             | Will be delivered. The note `host name allowlisted; its address is checked only with --resolve` means you should re-run with `--resolve`.    |
| `BLOCKED-AT-SAVE`     | The URL rule refuses it. The settings PUT would reject it, and the worker refuses every delivery.                                            |
| `BLOCKED-AT-DELIVERY` | The URL is fine, but the name resolves to a refused address (`--resolve` only).                                                              |
| `UNRESOLVED`          | The name did not resolve from this machine (`--resolve` only).                                                                               |

Each blocked line ends with what could fix it: add a host name, add an
address/CIDR, or `cannot be allowlisted` (the tenant must change the URL).

Exit codes, so the audit can gate a deploy:

| Exit | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | Every stored URL is allowed, or none are stored.                                                     |
| `1`  | At least one stored URL would be blocked.                                                            |
| `2`  | The audit could not run: DB unreachable, RLS-bound role, invalid allowlist, or node/build missing.   |
| `3`  | Nothing is blocked, but a host did not resolve (`--resolve`).                                        |

`deploy/oracle/deploy.sh` does not run the audit itself. Run it by hand before
the first deploy of the guard.

## 2. Decide per blocked URL

- **The receiver is not meant to be internal.** Examples: metadata,
  `localhost`, an internal service name, an address the customer does not own.
  The guard is doing its job. The tenant must change the URL. Do **not**
  allowlist it.
- **It is a legitimate on-prem receiver.** Allowlist it as described below, and
  keep each entry as narrow as you can.

## 3. Allowlist syntax and semantics

Entries are comma-separated. Leaving the variable empty or unset gives exactly
the guard's default behaviour.

**In `hyfib.env`, write the value in double quotes with no spaces**, for example
`OUTBOUND_WEBHOOK_ALLOWLIST="hooks.corp,10.1.2.3"`. It must be quoted or
space-free because `deploy/oracle/deploy.sh` validates `hyfib.env` by sourcing
it with bash. Bash misreads an unquoted value that contains a space
(`OUTBOUND_WEBHOOK_ALLOWLIST=hooks.corp, 10.1.2.3` runs `10.1.2.3` as a command),
so the variable is never set and that check passes whatever the entries are.
systemd's `EnvironmentFile` still hands the app the full value, so a bad entry
then crash-loops the app on the next restart. The app itself ignores whitespace
around entries.

| Entry                                      | Effect                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.corp`                               | A host name: exact match, case-insensitive, one trailing dot tolerated. It lifts only the **name** checks for that host.            |
| `*.branch.lan`                             | Any subdomain (`a.branch.lan`, `x.y.branch.lan`), but **not** `branch.lan` itself. List that separately if needed.                 |
| `10.1.2.3`, `10.1.2.0/24`, `fd00:1::/64`   | Addresses: these are permitted as IP literals in the URL and as resolved addresses at connect time. Host bits must be zero.        |

The name checks cover the internal suffixes (`.corp`, `.lan`, `.internal`,
`.local`, …) and single-label names.

The two kinds are independent, on purpose. A host entry **never** permits the
private address its name resolves to. An internal receiver `hooks.corp` that
resolves to `10.1.2.3` therefore needs **both** entries:

```
OUTBOUND_WEBHOOK_ALLOWLIST="hooks.corp,10.1.2.3"
```

| Listed                     | Save (PUT) | Delivery                  |
| -------------------------- | ---------- | ------------------------- |
| nothing                    | 400        | blocked                   |
| `hooks.corp` only          | accepted   | blocked (address refused) |
| `10.1.2.3` only            | 400        | blocked                   |
| `hooks.corp,10.1.2.3`      | accepted   | delivered                 |

**The hard floor can never be allowlisted**, even under `0.0.0.0/0` or `::/0`,
and even by an exact entry for the address:

- link-local `169.254.0.0/16` (cloud metadata) and `fe80::/10`
- cloud-metadata endpoints outside link-local, each an exact address: IPv6
  `fd00:ec2::254` (AWS), `fd20:ce::254` (GCP) and `fd00:c1::a9fe:a9fe` (Oracle
  OCI, the deploy target), and IPv4 `100.100.100.200` (Alibaba) and
  `192.0.0.192` (Oracle Cloud Classic). The IPv6 ones are unique-local
  (`fc00::/7`), not link-local, so `::/0`, `fc00::/7` or `fd00::/8` does not
  open them either.
- unspecified `0.0.0.0/8` and `::`
- multicast `224.0.0.0/4` and `ff00::/8`
- `240.0.0.0/4`, including `255.255.255.255`
- any IPv6 form that embeds one of these addresses (`::ffff:169.254.169.254`, NAT64, 6to4)

**Loopback** (`127.0.0.0/8`, `::1`) opens only for an entry that is itself
loopback: one inside `127.0.0.0/8`, or exactly `::1`. A broad range such as
`0.0.0.0/0` never opens it, and IPv6 spellings of an IPv4 loopback address
(such as `::ffff:127.0.0.1`) are never allowed. **Warning:** allowlisting
loopback lets every tenant with that callback host reach services on the app
host itself. Only do it for a receiver that really runs there. A wide range
that covers the app host's own private IP (or the Docker bridge, such as
`172.17.0.1`) exposes its services just the same, because app-server listens
on all interfaces. Prefer `/32` and `/128` entries.

Other points:

- Entries match their own address family only. `10.0.0.0/8` does not admit
  `::ffff:10.0.0.1`.
- An IPv6 spelling of an IPv4 address (IPv4-mapped `::ffff:…`, NAT64
  `64:ff9b::…`, 6to4 `2002:…`) is admitted only by an entry inside that form's
  own prefix, for example `::ffff:10.1.2.0/120` or `64:ff9b::a01:200/120`. A
  range meant to open IPv6, such as `::/0`, never opens private IPv4 hosts this
  way.
- DNS rebinding still fails. Each delivery resolves the name once, refuses the
  whole answer if **any** address is not allowed, and connects only to a vetted
  address. Redirects are never followed.
- Prefer single addresses (`/32`, `/128`) to wide ranges. `0.0.0.0/0` opens all
  private space apart from the hard floor and loopback, including the app
  host's own private and Docker-bridge addresses.
- A malformed entry (for example `10.1.2.3/24`, `*corp` or `hooks.corp:8443`)
  **stops the app from starting**, and the error names the entry. Do not rely
  on `deploy.sh` to catch it. Its config check sources `hyfib.env` with bash,
  so it sees the value only when it is quoted or space-free, and it runs only
  during a deploy, not when you edit `hyfib.env` and restart by hand. Validate
  before every restart (step 2 below).

## 4. Apply and verify

1. Edit `/etc/hyfib/hyfib.env` (for Docker Compose, `.env`) and set the value
   in double quotes with no spaces:
   `OUTBOUND_WEBHOOK_ALLOWLIST="hooks.corp,10.1.2.3"`.
2. **Validate before restarting.** Run the audit with no
   `OUTBOUND_WEBHOOK_ALLOWLIST` in the environment, so that it reads the new
   value from `hyfib.env` without sourcing the file:

   ```bash
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; bash /opt/hyfib/app/scripts/audit-status-callback-urls.sh --resolve"
   ```

   Expect exit `0`. Exit `2` with an error naming an entry means the value is
   invalid. Fix it and run the audit again, and do not restart until it
   passes. Exit `1` means some stored URLs would still be blocked (see
   section 2). The other exit codes are in section 1. For Docker Compose, run
   the audit from the checkout with `HYFIB_ENV_FILE=.env`.

   You can also use the `loadConfig` check that `deploy.sh` runs. It exits `1`
   and prints the offending entry. It sources the file with bash, so it tests
   the value only when the value is quoted or space-free:

   ```bash
   sudo bash -c "set -a; . /etc/hyfib/hyfib.env; set +a; node --input-type=module -e 'import(\"/opt/hyfib/app/packages/config/dist/index.js\").then((m) => { m.loadConfig(); }).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); })'"
   ```

3. Restart with `sudo systemctl restart hyfib-app` (or
   `docker compose up -d app-server`). The gateway (save time) and the worker
   (delivery) both read the variable at startup.
4. Watch `journalctl -u hyfib-app | grep customer_webhook_blocked`. Each line
   carries `host`, `reason` and a `hint` saying which entry would help, or that
   none can. It never includes the URL path, the query or the signing secret.
   A hint is offered only when following it works. A host-name hint means you
   list the `host`. An address hint means you list every address the `reason`
   names, as exact `/32` or `/128` entries. A broader CIDR admits loopback only
   if it lies inside `127.0.0.0/8`, and an IPv6 spelling of an IPv4 address
   only if it lies inside that form's own prefix (see section 3). When the
   answer holds any address that can never be allowed, or too many to name,
   the hint says that nothing can be allowlisted.

## 5. Residual risks

- **Tenant admins can discover the allowlist by probing.** The allowlist is
  global, one list for every tenant, and the save-time check must agree with
  the delivery-time check. A tenant admin can therefore learn which internal
  hosts and CIDRs are listed by trying saves: an allowlisted URL returns 200,
  anything else 400. The 400 never names the list, but the difference is the
  signal. For the same reason, every tenant can point its webhook at any
  allowlisted receiver, not only the customer it was added for. Keep entries
  narrow and exact: exact host names rather than `*.` suffixes, and `/32` or
  `/128` addresses rather than ranges.
- **`deploy.sh` does not see an unquoted value with spaces.** Its config check
  sources `hyfib.env` with bash (see section 3). An optional follow-up is to
  make that check read the file the way systemd's `EnvironmentFile` does. Until
  then, keep the value quoted and space-free, and validate before every restart.
