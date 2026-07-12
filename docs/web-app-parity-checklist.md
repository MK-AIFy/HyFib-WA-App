# Web-App Parity Checklist (cutover gate)

Tracks parity between the legacy vanilla-JS portal (`services/web-portal`) and the
new React app (`services/web-app`). The nginx `location /` cutover to `web_app`
should only happen once every row below is checked and repo-wide
`pnpm build && pnpm lint && pnpm test` is green.

| Area | Legacy capability | New app | Status |
|------|-------------------|---------|--------|
| Auth | Login (`/auth/login`) | `LoginPage` | ✅ |
| Auth | Register org+admin (`/auth/register`) | `RegisterPage` | 🚫 Retired 2026-07 — self-registration disabled (single-org); route now 410, page deleted. See [`docs/runbooks/single-org-deployment.md`](runbooks/single-org-deployment.md). |
| Auth | Session bootstrap (`/auth/me`), logout | `AuthProvider` | ✅ |
| Onboarding | Connect WhatsApp channel | `OnboardingPage` | ✅ |
| Shell | Role-filtered sidebar, SSE Live/Offline dot | `AppLayout` + `useSse` | ✅ |
| Shell | Mobile drawer nav | `MobileNav` (Sheet) | ✅ |
| Inbox | Conversation list + state filter | `ConversationList` | ✅ |
| Inbox | Client-side search over loaded page | `ConversationList` | ✅ (server search = backend follow-up) |
| Inbox | Unread indication | `unread.ts` (client last-read) | ✅ (unread_count = backend follow-up) |
| Inbox | Message thread + send (Enter/Shift+Enter) | `ChatPane` + `Composer` | ✅ |
| Inbox | Saved replies | `Composer` dropdown | ✅ |
| Inbox | State change (open/pending/closed) | `ChatPane` select | ✅ |
| Contacts | Search, table, consent badges | `ContactsPage` | ✅ |
| Contacts | Add contact, export CSV | `ContactsPage` | ✅ |
| Segments | List + create | `SegmentsPage` | ✅ |
| Campaigns | List, create, dispatch | `CampaignsPage` | ✅ |
| Templates | List with status | `TemplatesPage` | ✅ |
| Tasks | List, create, done/cancel | `TasksPage` | ✅ |
| Automation | Rules list + enable toggle; auto-replies | `AutomationPage` | ✅ |
| Analytics | KPI totals + audit log | `AnalyticsPage` | ✅ |
| Reports | KPI grid + 14-day trend (chart) | `ReportsPage` | ✅ (chart upgrade over legacy table) |
| Usage | Period selector + breakdown (chart) | `UsagePage` | ✅ (chart upgrade over legacy table) |
| AI Tools | Campaign draft generator | `AiToolsPage` | ✅ (segment-summary/lead-score deferred) |
| Settings | Workspace + channel + webhook | `SettingsPage` | ✅ |
| Users | List, invite, suspend/reactivate | `UsersPage` | ✅ |
| Teams | List | `TeamsPage` | ✅ |
| Tenants | List (platform_owner) | `TenantsPage` | 🚫 Retired 2026-07 — tenants console removed (single-org); routes now 404, page deleted. See [`docs/runbooks/single-org-deployment.md`](runbooks/single-org-deployment.md). |

## Accessibility upgrades over legacy (which had none)

- ARIA roles on conversation list (`listbox`/`option`) and message log (`log`, `aria-live`).
- Labeled icon-only buttons throughout.
- Skip-to-content link in `AppLayout`.
- Radix-based dialogs/sheets/menus provide focus trapping and Escape handling.
- Visible focus rings via the `--ring` token.

## Known deferred items (backend follow-ups, out of scope)

1. `unread_count` on `GET /api/v1/conversations` + mark-read endpoint.
2. Server-side conversation/message text search.
3. AI segment-summary and lead-score tools (endpoints exist; UI deferred).
4. `CardTitle` renders a `<div>`; wrap page titles in real headings where SR landmarks are needed.
