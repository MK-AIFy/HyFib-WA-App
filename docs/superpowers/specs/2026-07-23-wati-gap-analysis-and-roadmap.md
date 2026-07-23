# HyFib vs Wati.io — Gap Analysis and Enterprise Roadmap

**Date:** 2026-07-23
**Method:** 16-agent parallel audit — per-service feature inventory (10 agents),
Wati.io product research across five areas (5 agents, July 2026 sources), and an
enterprise production-readiness audit (1 agent).
**Goal:** Reach functional parity with Wati.io where it matters for HyFib's
positioning, and close the enterprise production-readiness gaps.

---

## 1. Where HyFib already matches or beats Wati

| Area | HyFib capability | vs Wati |
|------|------------------|---------|
| Shared inbox | States, assignment (agent/team), archive, pin, mark-read, unread counts, per-conversation + global pg_trgm message search, private notes, saved replies, SSE realtime, media in/out, typing indicator | At parity for core inbox; search is stronger |
| Message kinds | 9 outbound kinds incl. interactive, product, catalog, Flow, location, contacts | At parity (send-side) |
| Compliance | Consent-first policy engine (consent, opt-out STOP/START, 24h window, quiet hours by contact TZ, frequency caps), full action audit log | **Ahead** — Wati has no consent gate or full audit trail |
| Multi-tenancy | Postgres RLS + non-superuser role, per-tenant encrypted channel credentials | **Ahead** architecturally (Wati is per-DB isolation) |
| Campaign engine | Segment fan-out, atomic claims, token-bucket pacing, per-recipient funnel, scheduled campaigns, monthly quota | At parity for core sending |
| Automation | Auto-reply rules (keyword/contains/regex), rule engine (4 triggers × 4 actions), no-reply follow-ups | Basic parity (Wati adds more actions + quotas) |
| Security/CI | CodeQL, Gitleaks, Trivy, HMAC webhooks, CSRF, scrypt sessions, RBAC (7 roles) | **Ahead** of typical SaaS baseline |

## 2. Functional gaps (HyFib missing or half-built vs Wati)

### P0 — broken or half-built features (fix first; root causes, not new scope)

| # | Gap | Current state |
|---|-----|---------------|
| G1 | **Click tracking end-to-end** | `/r/:token` redirect + analytics listing + `link_clicks` repo exist, but **nothing mints shortlink tokens** — `linkClickRepository.create()` has zero call sites. Feature is dead at runtime. |
| G2 | **Campaign pause/cancel** | Status model supports `paused`; no endpoint ever sets it. |
| G3 | **Template lifecycle** | Local create is `pending` forever — no submit-to-Meta flow, no update/delete; sync is pull-only. |
| G4 | **Rule/entity editing** | Automation + auto-reply rules can only be toggled (no edit/delete); contacts/segments/teams/channels have no update/delete routes. |
| G5 | **Users PATCH roles** | Handler comment says status/roles; only status implemented. |

### P1 — high-value Wati features HyFib lacks

| # | Gap | Wati reference |
|---|-----|----------------|
| G6 | Broadcast **retargeting** by engagement (read / replied / clicked / ignored) | "Smart retargeting" (Pro) — HyFib already stores the funnel per recipient, so this is mostly a query + campaign-source feature |
| G7 | **Sequences / drip campaigns** (multi-step, delays, stop-on-reply) | Sequences (Pro) |
| G8 | **Working hours + welcome/out-of-office** built-in automations | Default Actions (all plans) |
| G9 | **Round-robin auto-assignment** + keyword routing to teams | Business tier |
| G10 | Campaign analytics **CSV export**; per-campaign click/reply rates in UI | Broadcast analytics (all plans) |
| G11 | **Agent performance reports** (FRT, resolution time, solved counts) | Operator reports (Pro) |
| G12 | **Public developer API** (API keys, versioned REST, outbound webhooks to tenant endpoints) + OpenAPI docs | Wati API + webhookEndpoints |
| G13 | **Website chat widget + click-to-chat link/QR generator** | Free tools + widget |
| G14 | **No-code chatbot flow builder** (visual canvas, template library) | Chatbot builder — biggest product-surface gap |
| G15 | **AI support agent** (KB-trained auto-answer with human handoff) + AI copilot (summaries, suggested replies, translation) | KnowBot/Astra/Co-pilot |
| G16 | **Commerce depth**: catalog management UI, order lifecycle (status transitions), payment links | Catalog + Auto Checkout + gateways |
| G17 | Multi-channel inbox (Instagram/Messenger/web chat) | Multi-channel (Pro) |
| G18 | CTWA ads attribution | Pro |

Deliberate divergences (do NOT copy Wati): keep the consent-first policy engine,
full audit trail, and self-hosted single-org deployment; Wati has no SSO — HyFib
already has a Keycloak seam, which is an enterprise differentiator worth
finishing rather than dropping.

## 3. Enterprise production-readiness gaps

| Sev | Gap |
|-----|-----|
| **Critical** | No implemented backups/DR — runbook only; single-disk VM loses all tenant data |
| High | No CD pipeline / image publishing; Trivy-scanned image ≠ shipped build |
| High | All 9 Dockerfiles use `--no-frozen-lockfile` (non-reproducible images) |
| High | Single-VM stop-the-world deploys; HA is doc-only |
| Medium | No tracing/histograms/alert rules; counters-only metrics |
| Medium | Zero tests in billing-usage + reporting services; app-server only 3 suites; no coverage gates |
| Medium | No OpenAPI spec (3,782-line hand-rolled router is the only contract) |
| Medium | Migrations: no checksums, no rollback path |
| Medium | Rate limiting fails open silently when Redis is down |
| Medium | Secrets in plaintext env files; Vault/Keycloak/OpenSearch ship in lab mode |
| Low | `pnpm audit \|\| true` non-blocking; no log shipping; fixed-window limiter bursts 2× |

## 4. Phased roadmap (one module per iteration, per project rules)

- **Phase A — Finish what's half-built (P0):** A1 click tracking end-to-end
  (G1); A2 campaign pause/cancel (G2); A3 template submit-to-Meta + edit/delete
  (G3); A4 rule/entity edit+delete routes (G4, G5).
- **Phase B — Campaign & inbox depth:** retargeting (G6), sequences (G7),
  working hours + welcome/OOO (G8), round-robin routing (G9), campaign
  analytics UI/export (G10), agent performance reports (G11).
- **Phase C — Platform hardening (interleave with B):** backups + DR drill
  (critical), CD + pinned images, OpenAPI generation, coverage gates, alerting.
- **Phase D — Developer platform:** API keys, outbound tenant webhooks, widget +
  link/QR generator (G12, G13).
- **Phase E — Bot builder & AI:** visual flow builder (G14), AI copilot/support
  agent (G15).
- **Phase F — Commerce & channels:** order lifecycle + payments (G16),
  multi-channel (G17), CTWA (G18).

## 5. Iteration 1 spec — click tracking end-to-end (G1)

**Why first:** it is a root-cause fix of a shipped-but-dead feature (project
rule 5), it is contained to one module iteration, and G6 retargeting and G10
analytics both depend on it.

**Design:** mint shortlinks at campaign-dispatch time in `notification-worker`.

1. When personalizing a recipient's template variables, any variable value that
   is an `http(s)` URL and the campaign has click tracking enabled gets
   replaced with `${PUBLIC_BASE_URL}/r/${token}` after inserting a
   `link_clicks` row (token → original URL, campaignId, contactId).
2. Token: 22-char base62 from `crypto.randomBytes` (no PII, unguessable).
3. Config: `PUBLIC_BASE_URL` already available to services via @hyfib/config
   (verify; add if absent). If unset → skip minting (log once), never break sends.
4. Minting failures must never fail the send: log + fall back to the original URL.
5. The existing `/r/:token` 302 + click recording + `GET
   /api/v1/analytics/link-clicks` complete the loop unchanged.

**Tests:** worker unit tests for URL-variable detection, token substitution,
mint-failure fallback, and disabled-config bypass; repository test for create +
recordClick round-trip stays in persistence (already covered).

**Out of scope for iteration 1:** rewriting URLs inside template *button*
components (needs template-component metadata), branded short domains, and the
retargeting query (Phase B).
