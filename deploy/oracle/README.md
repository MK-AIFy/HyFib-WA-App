# Deploying to an Oracle Cloud "Always Free" VM

Runs the whole platform on one free ARM VM: the app-server as a modular
monolith (`EVENT_BUS=memory`, no RabbitMQ), PostgreSQL 15 + Redis on
localhost, and Caddy terminating TLS, serving the web-app build, and
proxying `/api`, `/auth`, `/health` to the gateway. Production mode:
`NODE_ENV=production`, `AUTH_ENABLED=true` (session-cookie login), all
secrets generated on the VM.

## One-time manual steps (browser)

1. **Create the account** at <https://signup.oraclecloud.com> (a card is
   required for identity verification; Always Free resources never charge).
   Pick your home region thoughtfully — it cannot be changed, and A1 ARM
   capacity is scarcer in the most popular regions.
2. **Create the VM**: Compute → Instances → Create instance.
   - Image: **Ubuntu 24.04** (aarch64) · Shape: **VM.Standard.A1.Flex** with
     **4 OCPUs / 24 GB** (the full Always Free allowance).
   - Paste your SSH public key (`cat ~/.ssh/id_ed25519.pub`).
   - If creation fails with "Out of capacity", retry later or try another
     availability domain.
3. **Open ports 80/443**: the instance's Virtual Cloud Network → its subnet →
   Default Security List → Add Ingress Rules: source `0.0.0.0/0`, TCP,
   destination ports `80` and `443` (two rules).
4. **(Recommended) Reserve the public IP** (free): Instance → attached VNIC →
   IPv4 addresses → edit → Reserved public IP. Otherwise the IP changes if
   the instance is ever stopped.
5. **Point a domain at the IP** — TLS (and WhatsApp webhooks) need one.
   Free option: <https://www.duckdns.org> → sign in → create a subdomain →
   set it to the VM's public IP. Any domain you own works too (A record).

## Deploy (from this repo, on your machine)

```sh
deploy/oracle/deploy.sh ubuntu@<VM_PUBLIC_IP> <your-domain> [acme-email]
```

The first run provisions the VM (~5–10 min: packages, secrets, firewall,
systemd, Caddy) and then builds and starts the app. Re-run the same command
any time to redeploy the current working tree.

Afterwards:

```sh
ssh ubuntu@<VM_PUBLIC_IP> sudo cat /etc/hyfib/ADMIN_CREDENTIALS   # login credentials
open https://<your-domain>                                        # web UI
```

## Connecting real WhatsApp (later)

The stack runs fine without Meta credentials; to send/receive real WhatsApp
messages, edit `/etc/hyfib/hyfib.env` on the VM:

- `META_APP_SECRET` — from your Meta app dashboard (used to verify webhook
  signatures).
- In the Meta dashboard, set the webhook URL to
  `https://<your-domain>/api/v1/webhooks/meta/whatsapp` and use the
  `WEBHOOK_VERIFY_TOKEN` value from `hyfib.env`.
- Register your WABA/phone number via the UI or
  `POST /api/v1/channels/whatsapp`.

Then `sudo systemctl restart hyfib-app`.

## Operations

| Task | Command (on the VM) |
| --- | --- |
| App logs | `journalctl -u hyfib-app -f` |
| Caddy/TLS logs | `journalctl -u caddy -f` |
| Restart app | `sudo systemctl restart hyfib-app` |
| DB backup (manual run) | `sudo systemctl start hyfib-backup` — daily timer `hyfib-backup.timer` runs `scripts/backup.sh`; dumps in `/var/backups/hyfib` |
| DB restore | `sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh /var/backups/hyfib/<dump>"` (stop `hyfib-app` first) |
| Secrets / env | `/etc/hyfib/hyfib.env` (root-only, chmod 600) |

Layout on the VM: source is synced to `~/hyfib-src` (built there as the
`ubuntu` user), then installed to `/opt/hyfib/app` owned by the non-login
`hyfib` service user. `deploy/oracle/setup-vm.sh` is idempotent — re-run it
(e.g. with a new domain) to regenerate the Caddyfile without touching
existing secrets.
