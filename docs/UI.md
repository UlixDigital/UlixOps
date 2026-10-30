# UI

Source: docs/SPEC.md sections 3a and 3b.

## UI & Design (spec section 3a)

The UI is modern and minimal but not colourful: a clean, standard admin dashboard in the style of Vercel, Linear or Stripe.

- **Palette:** neutral greys (zinc/slate), white and near-black surfaces; ONE accent colour taken from the Ulix Digital brand: primary blue approx. #2563EB (hover/dark #1E40AF, deep navy #0B2A6F for the dark-mode sidebar), used for primary buttons, active nav, links and focus rings. Hex values are estimated from website screenshots; confirm against the brand file. Colour otherwise used only for status (green success, amber warning, red error), kept muted.
- **Themes:** light and dark mode, following the system setting with a manual toggle.
- **Components:** shadcn/ui on Tailwind CSS, lucide-react icons, Inter (or Geist) font. No gradients, heavy shadows or decorative illustrations.
- **Layout:** collapsible left sidebar (Dashboard, Sites, Plugins, Deployments, Backups, Audit Log, Settings), top bar with search (Cmd+K command palette) and user menu, content in cards and data tables.
- **Data tables:** sortable, filterable, with bulk-select for multi-site actions (TanStack Table).
- **Status:** small badges and progress indicators for job states; live deployment progress per site.
- **Feedback:** toast notifications, confirmation dialogs for destructive or bulk actions, skeleton loaders, clear empty states.
- **Quality:** fully responsive, keyboard accessible, WCAG AA contrast, subtle animations only (fades/transitions under 200 ms).

Dashboard layout to build: left sidebar navigation, top search bar, stat cards, and a live deployment table showing staging, phased batches, automatic rollback and pause. Values shown as — are placeholders filled from real data.

### Implementation notes

- Design tokens live in `apps/web/src/app/globals.css` as shadcn/ui CSS variables (`--background`, `--primary`, `--sidebar`, `--success`, ...). Components use tokens, never raw hex values.
- Dark mode follows `prefers-color-scheme`; a `.dark` / `.light` class on `<html>` overrides it for the manual toggle.
- `--primary` is #2563EB in both themes; white text on it passes WCAG AA (5.2:1). On near-black surfaces #2563EB text is only about 3.9:1, so dark-mode links and focus rings use the lighter `--link` / `--ring` tint of the same blue.

## Screens (spec section 3b)

Every screen uses the layout above (sidebar + top bar). Phase in brackets; build Phase 1 screens fully, show later-phase menu items as "Coming soon".

1. **Login + 2FA** [P1]: email/password, then TOTP or passkey. New-device alert, lockout after failed attempts, session-expired screen.
2. **Dashboard** [P1]: stat cards (sites, vulnerabilities, updates pending, last backup, sites down), live deployments, approvals waiting, recent alerts, recent audit events.
3. **Sites list** [P1]: table with name, URL, host, client/tag, WP version, PHP version, plugin updates, vulnerability count, last backup, uptime, health badge. Filters, search, bulk-select (deploy, update, snapshot, scan). Add site button.
4. **Add / edit site** [P1]: name, URL, host (WP Engine / other), production + staging details, SSH host/user/port, WP path, credential picked from vault, tags/client. Test connection button with results (SSH, WP-CLI, WP and PHP versions).
5. **Site detail** [P1], tabs:
   - Overview: versions, active theme, health, last deploy, last backup.
   - Plugins & themes: installed list with versions, update / activate / deactivate.
   - Deployments: history for this site.
   - Snapshots & backups: list with restore button.
   - Emergency: deactivate plugin, maintenance mode on/off, flush cache, roll back last change (works when wp-admin is down).
   - Logs: PHP error log viewer [P4], job logs [P1].
   - Security [P2], DNS [P3], Uptime & SSL [P3], Visual checks [P4].
6. **Plugin registry** [P1]: Ulix Digital custom plugins, latest version, number of sites on latest vs outdated.
7. **Upload plugin version** [P1]: drag-and-drop ZIP, version, changelog, "changes database" checkbox, checksum shown, validation result.
8. **Plugin detail** [P1]: version history and a site-by-version matrix; "update outdated sites" button.
9. **Deploy wizard** [P1], steps: choose plugin + version, choose sites (filters, bulk), rollout settings (staging first on/off, batch size, pause on failure, schedule now / later [P4]), review, then submit (sends approval request when bulk).
10. **Deployment live view** [P1]: per-site steps (queued, snapshot, staging, health check, deploying, done, rolled back, failed), live job log, pause / resume / cancel, manual rollback per site.
11. **Deployments history** [P1]: all deployments with who, when, plugin, sites, result; filter and export.
12. **Approvals** [P1]: pending requests with details, approve / reject with comment (requester cannot approve their own).
13. **Backups & snapshots** [P1 snapshots, P2 scheduled]: quick snapshots with expiry, scheduled full backups to Google Drive, schedule settings, retention, restore, "last tested restore" date.
14. **Security** [P2]: vulnerability list across all sites (severity, plugin/theme/core, affected sites, fixed version, one-click update), Wordfence CLI malware scan results, PHP version tracker, file integrity alerts.
15. **DNS** [P3]: Cloudflare domains, records table with add/edit/delete, snapshot + rollback of records, change alerts, migration checklist per domain, cache purge.
16. **Monitoring** [P3]: uptime per site, response time, SSL expiry, domain expiry, incident history.
17. **Visual checks** [P4]: before/after screenshots with diff highlight per deployment.
18. **Reports** [P4]: monthly per-client report (updates, backups, security, uptime), PDF export and email.
19. **Notifications** [P1]: in-app alert centre; settings for email / Slack per event type.
20. **Audit log** [P1]: searchable, filter by user, site, action, date; export; read-only.
21. **Users & roles** [P1]: invite user, set role (Admin / Developer / Viewer), force 2FA reset, deactivate, active sessions with revoke.
22. **Settings** [P1]: integrations (WP Engine API, Cloudflare token [P3], Google Drive [P2], Slack), vault connection status, credential rotation reminders, IP allowlist, session timeout, snapshot retention, health-check URLs and thresholds.
23. **My account** [P1]: profile, 2FA / passkeys, active sessions.
24. **Break-glass guide** [P1]: read-only page (also in README) with emergency manual-access steps if UlixOps is down.
