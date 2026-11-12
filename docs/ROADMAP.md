# Roadmap

Source: docs/SPEC.md sections 2 and 11. Work strictly in Build Order; tick a step only when it is finished and tested.

## Phases (spec section 2)

- [x] **Phase 1 (this spec):** secure foundation, auth & roles, site registry, SSH/WP-CLI connector, custom plugin registry, staged + phased deployments, pre-update snapshots, health checks, rollback, audit log, notifications. Target: WP Engine sites first.
- [x] **Phase 2:** vulnerability scanning (Wordfence Intelligence feed + Wordfence CLI), PHP version tracker, file integrity monitoring, scheduled encrypted backups to Google Drive.
- [ ] **Phase 3 (in progress, see Phase 3 Build Order):** Cloudflare DNS management (migration, editing, snapshots, change alerts), SSL & domain expiry alerts, uptime monitoring.
- [ ] **Phase 4 (in progress):** visual checks, scheduled updates, PHP error log, and monthly reports done; non-WP Engine hosts still open.

Build Phase 1 so that later phases plug in cleanly (modular services, shared job queue, shared audit log).

## Phase 1 Build Order (spec section 11)

- [ ] **Step 0, before coding (human tasks):**
  - [x] Provision VPS: AWS EC2 `ulixops@18.218.128.255` (hardened with `scripts/vps-setup.sh`)
  - [ ] Set up Cloudflare Zero Trust: Access app + tunnel for `ulixops.ulixdigital.com` (docs/DEPLOY.md)
  - [x] Set up the secrets vault: self-hosted Infisical in the stack (A46); set up locally 2026-10-29, on the VPS by the first `scripts/deploy.sh` run
  - [ ] Get WP Engine SSH Gateway access + API credentials
  - [ ] Pick ONE low-risk test site
  - [ ] Create Slack webhook / SMTP
- [x] **1. Repo bootstrap:** all files from section 0, monorepo skeleton, Docker Compose (web, api, runner, postgres, redis, test WordPress with SSH + WP-CLI), CI with lint, type-check, tests, dependency audit. _Done 2026-10-29._
  - [x] Section 0 files (CLAUDE.md, docs/, .claude/rules/, .env.example, docker-compose.yml, README.md)
  - [x] Monorepo skeleton: apps/web, apps/api, apps/runner, packages/shared (pnpm workspaces)
  - [x] Prisma schema (spec 14.3) + initial migration
  - [x] Safe command builder (spec 14.2) with unit tests
  - [x] Docker Compose with network segmentation and hardened containers
  - [x] Test WordPress image (SSH key-only + WP-CLI, pinned and checksum-verified)
  - [x] CI: lint, format check, type-check, tests, dependency audit, compose build; Dependabot
  - [x] Hub stack verified on real Docker (AWS EC2): all images build, migration applies, api/postgres/redis healthy, web shows API healthy, only 127.0.0.1 listeners
  - [x] Test WordPress container verified locally (2026-10-29): installs itself; key-only SSH as `wpdev`; every allowlisted op works over SSH (plugin list/activate/deactivate, core version, maintenance mode, cache flush, db export); password/root logins and SSH tunnelling refused
  - [x] Network boundaries verified: runner reaches sites and Redis but not Postgres; API reaches Postgres and Redis but not sites; web reaches only the API
- [x] **2. Auth:** login, mandatory 2FA, sessions/timeouts, lockout, new-device alerts. _Done 2026-10-29._
  - [x] First Admin via `create-admin` CLI + one-time setup link; password set in the browser
  - [x] Email/password, then TOTP; QR enrollment required before any session; single-use codes
  - [x] Sessions: 30 min idle, 12 h absolute; `__Host-` Secure/HttpOnly/SameSite=Strict cookies; session-expired screens
  - [x] Lockout (5 failures / 15 min per email) and IP rate limit (30 / 15 min) in Redis
  - [x] New-device alerts stored and logged (delivery channels in step 11)
  - [x] Verified: 52 API tests incl. 9 real-Postgres flows; no-JS browser-flow check of every page against the running stack
- [x] **3. RBAC** (Admin / Developer / Viewer) + append-only audit log. _Done 2026-10-29._
  - [x] Separate Postgres roles: migrator (owner) vs app (INSERT/SELECT only on `AuditLog`), plus a trigger blocking UPDATE/DELETE for every role
  - [x] Permission map shared by API and web; API checks every route; refusals audited
  - [x] Approval rule (Admins only, never their own request) unit-tested for step 10
  - [x] Admin-only Audit log page with filters and paging (moves to the app-shell data table in step 4, with CSV export)
  - [x] Verified: 161 tests (incl. database-level denial for the app role and the owner); live stack runs as `ulixops_app`
- [x] **4.** Users & roles screen, My account, Settings skeleton, IP allowlist. _Done 2026-10-29._
  - [x] App shell: collapsible sidebar (later items "Coming soon"), top bar with Cmd+K palette and user menu, light/dark/system theme, mobile menu, toasts
  - [x] Dashboard skeleton: stat cards, live deployments placeholder, recent alerts and activity (Admins)
  - [x] Users & roles: invite with one-time link, change role, remove/restore access, reset 2FA, password reset link, end sessions
  - [x] My account: profile, 2FA status, own sessions (sign out everywhere else), role permissions
  - [x] Settings skeleton: integrations status, sign-in policy, upcoming settings
  - [x] IP allowlist: enforced in the web proxy, `ALLOWED_IPS` always allowed, anti-lockout
  - [x] Audit log as a sortable data table with CSV export
  - [x] Passkeys (WebAuthn) as a second factor, added with a step-up code; verified with a software authenticator (real P-256 signatures)
- [x] **5.** Site registry + vault-backed credentials + Test connection (runner only). _Done 2026-10-29._
  - [x] Self-hosted Infisical vault on internal networks; runner machine identity via `vault-setup`; API holds no vault login (A46)
  - [x] Runner SSH executor (`ssh2`, argv only, POSIX-quoted), pinned host keys, output redaction (A47, A49)
  - [x] API ↔ runner request/answer over BullMQ with timeouts; stale jobs refused (A49)
  - [x] Sites: add / edit / archive / restore, production + optional staging, tags, host and tag filters (A47, A52)
  - [x] Smart WP Engine add-site: URL + vault key (+ install hint when needed); auto SSH fill and Test connection (A107)
  - [x] Bulk plugin/theme update approval UX: review gate, approver list, background run, live progress, report, failure alerts (A104–A108)
  - [x] New SSH key, server, port or user and host-key resets wait for a second Admin; Approvals screen (A47, A48)
  - [x] Settings → Credentials: create Ed25519 keys in the vault (public key shown once), usage per site, 90-day rotation reminders (A50)
  - [x] Test connection: vault → SSH → WP-CLI → WordPress, versions stored, host key pinned on first success, mismatch alert (A51)
  - [x] Verified: API integration tests (stub runner), runner unit + real-SSH tests against `test-wp`, live flow on the local stack
- [x] **6.** Site detail: inventory via WP-CLI, plugins & themes, emergency actions. _Done 2026-10-29._
  - [x] Site detail tabs: Overview, Plugins & themes, Emergency, Logs; later tabs show "soon"; Production / Staging switch
  - [x] Inventory over WP-CLI (`site.inventory`): WordPress, PHP and WP-CLI versions, active theme, plugins and themes with available updates, maintenance mode; safe-mode fallback when a plugin crashes WP-CLI (A54, A56)
  - [x] Plugins & themes: activate / deactivate per environment; update counts on the sites list and dashboard; the Update button waits for snapshots in step 8 (A57)
  - [x] Emergency: deactivate a plugin, maintenance mode on/off, flush cache, all with plugins and themes skipped; "Restore latest snapshot" waits for step 8 (A54)
  - [x] Job log per site with redacted output; pinned host key required; one command at a time per environment; host-key mismatch alerts (A58)
  - [x] Permissions per action and environment (`sites.refresh`, `siteActionPermission`), unit-tested (A55)
  - [x] Verified: shared, runner and API tests (stub runner); real-SSH tests against `test-wp` including a deliberately broken plugin (A59); live UI flow on the local stack: break the site, recover it from Emergency, maintenance mode on/off
- [x] **7.** Plugin registry + secure ZIP upload + version tracking. _Done 2026-10-29._
  - [x] Registry (screen 6): custom plugins, latest version, production sites on latest / outdated / without it
  - [x] Upload (screen 7): drag-and-drop ZIP, checks shown step by step, SHA-256 shown, version from the plugin header, changelog, "changes database" flag (A62, A65)
  - [x] ZIP checks: size, content type, strict structure, paths, layout, header, full unpack with CRC and a contents scan (A61)
  - [x] Storage outside any web root: quarantine until saved, then stored by checksum in the `plugin-store` volume; re-checked on save (A63)
  - [x] Plugin detail (screen 8): version history and site-by-version matrix from the inventories; "Update outdated sites" waits for step 10 (A64)
  - [x] ZIPs made on macOS accepted: Finder metadata is checked, ignored and left out of the stored copy (A66)
  - [x] Step 6 follow-up: "one command per environment" is now an atomic claim that survives crashes (A60)
  - [x] Verified: ZIP unit tests (hostile archives built byte by byte, plus real ZIPs from Python and `zip`); API integration tests (Postgres); live UI flow on the local stack with test-wp
- [x] **8.** Quick pre-update snapshots + retention. _Done 2026-10-29._
  - [x] Runner SFTP capture of plugin folder (+ optional DB export), encrypted store, restore
  - [x] Backup model, retention (Settings + SNAPSHOT_RETENTION_DAYS), purge of expired files
  - [x] UI: Backups page, site Snapshots tab, Update button (snapshot-first), Emergency rollback
  - [x] Verified: unit + API integration + real-SSH snapshot/restore against test-wp
- [x] **9.** Health checks. _Done 2026-10-29._
  - [x] Runner HTTP checks for homepage + wp-admin + Settings extra paths; critical-error body text; response-time threshold (A76–A78)
  - [x] Optional SFTP tail of `wp-content/debug.log` for recent fatal/parse lines
  - [x] Persist `lastHealthAt` / `lastHealthOk` / `lastHealthSummary` per environment; Settings → health-check URLs and threshold
  - [x] UI: site overview Health, Run health check, sites-list Health column, Settings form
  - [x] Verified: shared unit tests; runner unit tests (mocked fetch); API integration tests (stub runner)

- [x] **10.** Deploy wizard + approvals + staging-first + phased rollout + automatic rollback + live view. _Done 2026-10-30._
  - [x] Shared contracts + Prisma `Deployment` / `DeploymentTarget` expansion; runner `site.plugin.deploy` from read-only plugin-store (A81)
  - [x] API create/list/pause/resume/cancel; bulk → Approvals `deploy.bulk`; in-process orchestrator snapshot → deploy → health → auto-rollback (A82, A83)
  - [x] Web: Deployments history, wizard (screens 9–11), live view with polling; plugin "Update outdated sites"; dashboard live list
  - [x] Second test WordPress container as staging (`test-wp-staging`, A84)
  - [x] Verified: shared + runner unit tests; API integration tests (stub runner) for single deploy, bulk approval, health-fail rollback
- [x] **11.** Notifications (email, Slack, in-app). _Done 2026-10-30._
  - [x] In-app alert centre (`Notification` rows per recipient); mark read / mark all read (A85)
  - [x] Email via `SMTP_URL` (nodemailer) and optional Slack webhook; Admin prefs per event on Settings (A86, A87)
  - [x] Wired: security alerts, deploy started/finished/failed/rollback, approval requested
  - [x] Verified: shared unit tests; API channel + integration tests (stub mailer/Slack)
- [x] **12.** Hardening pass: security review against section 5, e2e test of deploy, fail, rollback using a deliberately broken plugin on the test site. _Done 2026-10-30._
  - [x] §5 review filed (gaps closed or deferred with A-decisions): site archive needs second Admin; orchestrator outcomes audited; empty first-install snapshots; hub DB backup script; out-of-hours bulk deploy audited (A90–A95)
  - [x] Real-SSH e2e: `apps/runner` deploy → failed health → restore (`TEST_WP_SSH`); Playwright smoke for deployments UI (`pnpm test:e2e` with `E2E_BASE_URL`)
  - [x] Deferred to later phases / ops: Cloudflare Access policies, SFTP-only / FTP hosts, one-click key rotation, AV ZIP scan, automated off-box backup copy
- [x] **13.** Phase 1 acceptance (section 10). Only then start Phase 2. _Accepted by the owner 2026-10-31 (A129)._
  - [x] Owner sign-off based on live use (30 WP Engine sites, Test connection, bulk updates, snapshots) and the step 12 e2e suite
  - [ ] Not re-verified at sign-off: Cloudflare Access policy + `ALLOWED_IPS` on live; Developer-role upload → staging → approved phased rollout; broken-plugin rollback on live test site; secrets sweep of logs/UI

## Phase 2 Build Order (owner-approved 2026-10-31, A130)

The spec gives Phase 2 features but no order; smallest first.

- [x] **P2-1.** PHP version tracker: support status per environment (supported / security-only / ending / end-of-life), sites list badge, site detail, dashboard count. _Done 2026-10-31 (A130)._
  - [x] `phpSupport()` in shared with php.net support dates; 14 unit tests
  - [x] Sites list PHP column badge (ending / end of life), sortable by status; site detail "PHP support"; dashboard "Outdated PHP" card
- [x] **P2-2.** Vulnerability scanning: match core, plugin and theme versions against the Wordfence Intelligence feed; per-site results and alerts on new matches. _Done 2026-10-31 (A132)._
  - [x] Runner `vuln.feed`: vault key → streamed v3 production feed → records for installed software only; unit tests incl. chunk-split parsing and key never echoed
  - [x] API: `Vulnerability` / `VulnerabilityFinding` (migration), PHP `version_compare` matching, open/resolve/reopen, re-match after inventory writes, daily scheduler, audit + `vulnerability.found` notifications; Postgres integration tests
  - [x] Web: Security page (open / resolved, severity counts, Sync feed now), site Security tab, sites list Vulnerabilities column, dashboard count, Settings → Integrations status
  - [x] Settings → Credentials: Wordfence API key entry after second-Admin approval, sealed to the runner, vault only (A133)
  - [x] Owner: request the key in Settings → Credentials, second Admin approves, paste the key (docs/DEPLOY.md Notes) _Done 2026-10-31._
- [x] **Ops (2026-10-31):** Super Admin role with self-approval and alerts to the other Admins (A134); WordPress core update with automatic rollback, plus honest "Not checked" update status (A135); long actions no longer break behind Cloudflare, "working on this site" banner, dismissable bulk reports (A136); delete inactive plugins/themes with a snapshot first (A137).
- [x] **P2-3.** Malware scan: Wordfence CLI over SSH as an allowlisted runner op; results stored per site. _Done 2026-10-31 (A138); engine switched to ClamAV + YARA webshell rules after Wordfence discontinued CLI (A140)._
  - [x] Scanner sidecar container (ClamAV + pinned, hash-checked YARA webshell rules; hardened, 2 GB cap); runner streams a filtered copy over SSH into the shared `scan-work` volume
  - [x] API: scans + findings, one at a time, weekly rotation, alerts, audit; UI on the site Security tab and the Security page
  - [x] Verified: copy/scan unit tests (hostile tar entries), real-SSH copy of test-wp, scanner image built and run: EICAR + PHP backdoors caught, no false positives on clean WordPress, only WP File Manager flagged across 7 popular plugins
  - [x] Security → Malware scans page: queue, live progress %, stop, schedule (frequency, UTC window, staging, per-site switch), completed scans, scan details, known-safe matches (A143)
- [x] **P2-4.** File integrity monitoring: core checksums and changed plugin files. _Done 2026-10-31 (A144)._
  - [x] Runner `site.integrity`: WP-CLI core + plugin checksums over SSH; parsers tested on real WP-CLI output; real-SSH test tampers test-wp files and restores them
  - [x] API: checks, findings, expected-change rules, alerts on new changes only, daily schedule (shared with malware scans); Postgres integration tests
  - [x] Web: Security → File integrity, check details, site Security tab card, schedule option
- [x] **P2-5.** Scheduled encrypted full backups to Google Drive (service account, folder per site, retention). _Done 2026-10-31 (A145): personal Drive via “Sign in with Google” instead of a service account; weekly, latest copy only._
  - [x] Runner: ULXB streaming encryption, Drive client (device sign-in, resumable upload, verify, permanent delete), `site.backup` job; real-SSH backup of test-wp decrypted and checked
  - [x] API: queue, weekly schedule, health check first, keep-latest retention, stop, alerts, audit; Postgres integration tests
  - [x] Web: Backups → Full backups (Drive setup + connect, progress, schedule, sites, history, restore steps); Drive connection and key cards in Settings → Google Drive (A146); only healthy sites listed (A147)
  - [x] `scripts/decrypt-backup.mjs`: restore without the hub
  - [x] “Sign in with Google” (redirect + PKCE) and Settings → Google Drive (A146)
  - [x] Owner: Google Cloud Web application client, backup key, Sign in with Google (Settings → Google Drive) _Done 2026-10-31._
- [x] **P2-5b.** Restore a full backup from Google Drive inside the hub (owner request, between P3-2 and P3-3). _Done 2026-11-01 (A152)._
  - [x] Shared: allowlisted `restore.database` / `restore.files` (tar from stdin, never the dump or `wp-config.php`), `site.backup.restore` + `drive.delete` jobs, `backups.restore` permission (Admin), restore views; unit tests
  - [x] Runner: streaming ULXB decryptor, resumable Drive download, SSH stdin streaming; key check → safety copy → maintenance → database import / files extract → cache flush; refuses stream ops as plain commands; unit tests with fake Drive + SSH, plus a real-SSH round trip on test-wp (everything, then database only)
  - [x] API: `FullRestore` + safety copies on `FullBackup` (migration), approval `site.backup.restore` (second Admin; Super Admin self-approve), one at a time with backups and scans, site lock, health check afterwards, alerts, safety copies deleted from Drive after 7 days, audit; Postgres integration tests
  - [x] Web: Backups → Restore (site, backup, what to restore, type the name, confirm), restore history with progress, safety copy "Undo"; Restore links on Full backups; Approvals label

- [x] **P2-5c.** Restore into a chosen environment, including a backup of the site's other environment (owner request "B", after P3-3). _Done 2026-11-01 (A157)._
  - [x] Shared: `target` on the restore request, `targets` in the overview, `sourceEnvironment` on restores; allowlisted `db.prefix`, `restore.dump-prefix`, `db.search-replace` (site address, plain + JSON-escaped, `--all-tables-with-prefix --skip-columns=guid`), restore-only on the runner; unit tests
  - [x] Runner: across environments, table prefixes compared before the import (refused if different, nothing changed), site address changed after it; unit tests, plus the real commands run on test-wp (no-op search)
  - [x] API: target environment of the same site, approval text names the copy, `rewrite` from both environments' URLs; Postgres integration tests (production → staging, own environment, no staging)
  - [x] Web: Restore form Site → Restore to (Production / Staging) → backup of either environment, copy warning, "no backup of its own yet" hint; history shows "production weekly backup" on a copy
  - [x] **A174.** Cross-environment restore (either direction) clears the target database and its plugins, themes and uploads before the copy, then rewrites the site address to the target domain. `wp-config.php` stays. Same-environment restores still overlay.

- [x] **Site Files (owner request).** Browse and edit the WordPress tree over SSH/SFTP. _Done 2026-11-04 (A179)._
  - [x] Shared: `RelPath` / `site.files` job ops; list/read/mutate result schemas; 1 MiB / 500-entry caps
  - [x] Runner: `listDir` on SFTP + ShellFs; `runSiteFiles` under `wpPath`; unit tests
  - [x] API: `/sites/:id/environments/:kind/files*` with lock + audit (path only); JSON body limit 2 MiB
  - [x] Web: site **Files** tab — breadcrumb, create/upload/rename/delete, text editor, secret-file notice
  - [x] **A180.** One-shot `ls -la` listing (no `sh -c`); optional dedicated SFTP endpoint on Files tab (FileZilla-style host/port) with `nativeSftpOnly`
  - [x] **A181.** Soft-fail Files SFTP auth/connect with clear detail; "Fill from site SSH" helper
  - [x] **A182.** Dedicated Files SFTP password auth (sealed vault secret; FileZilla-style)
  - [x] **A183.** Files SFTP session pool + faster list / non-blocking Files tab

## Phase 3 Build Order (A148)

The spec gives Phase 3 features but no order; smallest first, as proposed in the handover.

- [x] **P3-1.** SSL certificate and domain expiry alerts. _Done 2026-10-31 (A148)._
  - [x] Shared: public-host and domain-candidate rules, thresholds (30/14/7/3/1/expired), job + view contracts; unit tests
  - [x] Runner `monitor.expiry`: TLS handshake (trust, name, validity) + RDAP via the IANA bootstrap; unit tests with fake TLS/RDAP, plus a manual check against example.com, iana.org, badssl.com and denic.de
  - [x] API: `SslCertificate` / `DomainRegistration` (migration), alerts once per threshold and per renewal, "couldn't connect" only twice in a row, manual domain date, daily schedule, audit; Postgres integration tests
  - [x] Web: Monitoring → SSL & domains, site Uptime & SSL tab with Check now, dashboard "Expiring soon"
- [x] **P3-2.** Uptime monitoring: per-site checks every few minutes, response time, incidents (down/up alerts), sites list uptime column, dashboard "Sites down". _Done 2026-10-31 (A149)._
  - [x] Shared: probe job + result contracts, "up" rule (< HTTP 500, no WordPress error page), down-after-2 state machine, uptime %, views; unit tests
  - [x] Runner `monitor.uptime` on its own `monitor-ops` queue (never waits behind scans/backups): GET with manual redirects (public hosts only), 10 s timeout, one retry, 10 in parallel; unit tests with fake fetch, plus a real probe of the local `test-wp` container
  - [x] API: `UptimeMonitor` / `UptimeCheck` / `UptimeIncident` (migration), every 5 min, incidents + `uptime.down` / `uptime.up` alerts, hub-job lock and all-sites-failed guards, pause/resume (Admin), Check now, 30-day samples / 1-year incidents, audit; Postgres integration tests
  - [x] Web: Monitoring → Uptime (default tab), site Uptime & SSL tab (status, 24 h / 7 / 30 days, hourly strip, incidents), sites list Uptime column, dashboard "Sites down"
- [x] **P3-3.** Cloudflare DNS management: scoped API token (DNS edit only, owner-created), zones and records table with add / edit / delete, snapshot before every change + rollback, change alerts, migration checklist, cache purge. _Done 2026-11-01 (A156); live use needs the owner's Cloudflare token._
  - [x] Shared: record rules per type (A, AAAA, CNAME, TXT, MX managed; others read-only), names relative to the zone, rollback planning, diff text, migration steps, `dns.*` jobs on the `monitor-ops` queue, `dns.manage` permission (Admin), `dns.changed` alert; unit tests
  - [x] Runner: Cloudflare client (zones, records, ordered changes stopping at the first failure, cache purge), token from the vault only and redacted from every error; unit tests with a fake API, plus a read-only check against the real API (ulixdigital.com, 31 records)
  - [x] API: `DnsZone` / `DnsSnapshot` / `DnsChange` / `DnsRollback` (migration), read every 6 hours (hourly tick) with outside-change alerts, snapshot before and after every edit, rollback via `dns.rollback` approval, purge, checklist, audit; Postgres integration tests
  - [x] Web: DNS in the sidebar (domains list, domain page: records add / edit / delete, snapshots + rollback, change history, migration checklist, cache purge); Cloudflare token card in Settings → Credentials with creation steps
  - [x] Owner: created the Cloudflare token and entered it in Settings → Credentials _(2026-11-01)_

- [x] **P3-4.** Alert follow-up (owner request 2026-11-01, not in the spec): unread alerts in a top-bar bell with popups, and a Super Admin page tracking who saw each alert, who fixed it, what they did and whether the fix held. _Done 2026-11-01 (A158); not deployed yet._
  - [x] Shared: `Alert` statuses + state machine, fix outcomes / actions, auto-verified and recovery kinds, `alerts.track` permission (Super Admin only), report and detail views; unit tests
  - [x] API: `Alert` / append-only `AlertEvent`, `Notification.alertId` + `seenAt` (migration with backfill), repeats join the open alert, a repeat after a reported fix rejects it, clean re-checks (malware, integrity, uptime, SSL, domain, backup, restore, approvals) confirm it, seen / take / report-fix / confirm / reject / reopen with audit rows, passive session check for polling; unit + Postgres integration tests
  - [x] Web: bell with unread count and popups in the top bar (critical stays until dismissed), "I'm on it" and "Report fix" on Notifications, Alert follow-up page (summary tiles, follow-up steps, raised vs closed chart, team table with accuracy, open / awaiting check / closed lists) and per-alert page (steps with timings, who saw it, timeline, audit evidence, confirm / reject / reopen)

## Phase 4 Build Order (A161)

The spec lists Phase 4 features (§2) without an order; smallest and most useful first, as for Phase 3. Owner said "let's build Phase 4" on 2026-11-01.

- [x] **P4-1.** Central PHP error log viewer. _Done 2026-11-01 (A159)._
  - [x] Shared: debug.log parser (levels, grouping, stack traces, short paths, plugin/theme/core/host source, 24-hour counts), job + view contracts, `php.fatal` alert; unit tests with real WSI lines
  - [x] Runner `site.errorlog`: last 512 KB of wp-content/debug.log over SSH, read-only, secrets redacted; unit tests, plus a real read on test-wp
  - [x] API: `PhpErrorLog` (latest reading per environment, migration), production read every 6 hours (hourly tick), Read now, alert only on fatal errors newer than the last alerted and from the last day, last good reading kept on failure, audit; Postgres integration tests
  - [x] Web: Monitoring → PHP errors (all sites, 24-hour counts, newest serious error), site Logs tab PHP error log (production / staging, Read now, grouped messages with stack traces)
- [x] **P4-1b.** PHP error logging switch (owner: "if debug.log is off, can we turn it on?"). _Done 2026-11-01 (A160 → A167)._
  - [x] Shared: logging state, `site.debuglog` job, bulk approval `site.debuglog.bulk`, `php.logging` alert; A167 mu-plugin paths + plugin source; unit tests
  - [x] Runner **A167/A168:** install/remove `mu-plugins/ulixops-error-log.php` + private `ulixops-logs/php-errors.php` (PHP exit header for nginx/WP Engine; no wp-config edits); probe not downloadable; read prefers UlixOps log; trim private log only; unit tests
  - [x] API: managed flag, switch per environment (Admin, audited), bulk after approval; reverted when plugin missing; Postgres integration tests
  - [x] Web: site Logs tab status + Switch logging on/off (mu-plugin copy); Monitoring → PHP errors Logging column
- [x] **P4-2.** Scheduled updates: plugin / theme / core updates at a set time per site, with snapshot, health check and rollback. _Done 2026-11-01 (A162)._
  - [x] Shared: weekly window maths (3-hour grace), planner (patch/minor automatic, majors listed, WordPress maintenance releases only, skip list, held versions, production limited to versions staging runs), run reports and views, `autoupdate.completed` / `autoupdate.problems` alerts; unit tests
  - [x] API: `AutoUpdateSchedule` / `AutoUpdateRun` (migration), switching on via `site.autoupdate.enable` approval (one or many sites; Super Admin self-approve), window / skip list / off / clear hold (Admin, audited), hourly-tick run staging → production reusing the bulk-update path with stop-on-first-problem and healthy-start, holds, interrupted-run recovery, alerts; Postgres integration tests
  - [x] Web: site Plugins & themes → Scheduled updates card (status, switch on/off, window and skip list, held versions, run reports); Plugins → Scheduled updates (all sites, switch on several)
- [x] **P4-3.** Before/after visual checks (Playwright screenshots with diff) on deploys and updates. _Done 2026-11-01 (A163)._
  - [x] Shared: page list from health paths (never wp-admin), settings, job + view contracts; unit tests
  - [x] Playwright sidecar (`docker/visual`) + runner `site.visual.capture` on `visual-ops` (public URLs only, loopback rewrite); pixelmatch diffs; unit tests for URL prep
  - [x] API: `VisualCheck` / `VisualPage` (migration), before/after around deploys and bulk/auto updates, manual Check now, alert `visual.changed` / `visual.failed` (no auto-rollback), authenticated PNG GET, settings; retention 30 days
  - [x] Web: Monitoring → Visual checks, site Visual checks tab, before/after/diff gallery
- [x] **P4-4.** Monthly site reports (issues + time-to-fix, then updates/backups/security/uptime), PDF export and email. _Done 2026-11-01 (A164 → A165)._
  - [x] Shared: month windows, per-site summary + issue schemas; unit tests
  - [x] API: aggregate from Alert follow-up + AutoUpdateRun / deployments / FullBackup / vulns / malware / integrity / uptime; `SiteReport` (migration `20261101090000`); pdfkit PDF (glance → severity → issues → details); email with attachment; 1st-of-month scheduler; notify `report.ready`
  - [x] Web: Reports in sidebar, one row per site, generate / detail / download PDF / email Admins (+ optional extras)
- [ ] **P4-5.** Support for hosts other than WP Engine.

## Coming soon: built-in version control for client sites (owner request 2026-11-01, A153)

Planned, **not started**. Build only after the current steps (Phase 3, including P3-3) are done. Not in the spec; the owner's requirements are recorded here and in DECISIONS.md A153. **No Git or GitHub:** UlixOps keeps the version history itself.

Owner's requirements:

- Track every code change on every connected website: who, when, which environment, what changed.
- The team edits the **Development** environment the way they like (VS Code Remote-SSH / SFTP, Local by Flywheel push, WordPress editor). UlixOps picks the changes up and alerts.
- Someone reviews the change. If it's OK, UlixOps applies it to **any environment**: development, staging or production.
- Any environment can go back to an earlier version.
- WP Engine **development** environments can be added as well as production and staging.

Planned steps:

- [ ] **V-1.** Development environment: third environment kind (`DEVELOPMENT`) next to production and staging, WP Engine import picks up dev installs, treated like staging for permissions.
- [ ] **V-2.** Restore to another environment: production ↔ staging ↔ development from a Drive backup, with `wp search-replace` of the site URL, a table-prefix check, the safety copy and approval when production is the target.
- [ ] **V-3.** Versions: runner reads `wp-content/themes`, `plugins` and `mu-plugins` over SSH (never `wp-config.php`, uploads, caches or `.env` files) and saves a version (manifest of path + SHA-256 + size, author, environment, time). File contents are kept once each in the encrypted content-addressed snapshot store, so a new version only adds changed files. Saved on a schedule, before and after every deploy / update / restore, and on **Save version**. Retention policy decided at build time.
- [ ] **V-4.** Change detection and alerts: compare against the last version (alongside the daily integrity check); "N files changed in <theme/plugin> on <site> (<env>)" alert.
- [ ] **V-5.** Review: site **Versions** tab, list per environment, changed files, side-by-side text diff (binary files shown as changed), Approve / Reject with comment, audit.
- [ ] **V-6.** Apply an approved version to one or more environments, reusing the deploy pipeline: snapshot, upload changed files only (and remove deleted ones), health check, automatic rollback; approval for production and multi-environment. Each environment shows which version it runs.
- [ ] **V-7.** Roll back any environment to an earlier version (same pipeline and approvals).

Limits (agreed): versions cover **code only**; page-builder content, posts, settings and orders live in the database and stay covered by backups and restores. No branches or merging: the team shares the Development environment, so two people editing the same file at once overwrite each other.
