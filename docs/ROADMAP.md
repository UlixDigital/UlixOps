# Roadmap

Source: docs/SPEC.md sections 2 and 11. Work strictly in Build Order; tick a step only when it is finished and tested.

## Phases (spec section 2)

- [ ] **Phase 1 (this spec):** secure foundation, auth & roles, site registry, SSH/WP-CLI connector, custom plugin registry, staged + phased deployments, pre-update snapshots, health checks, rollback, audit log, notifications. Target: WP Engine sites first.
- [ ] **Phase 2:** vulnerability scanning (Wordfence Intelligence feed + Wordfence CLI), PHP version tracker, file integrity monitoring, scheduled encrypted backups to Google Drive.
- [ ] **Phase 3:** Cloudflare DNS management (migration, editing, snapshots, change alerts), SSL & domain expiry alerts, uptime monitoring.
- [ ] **Phase 4:** before/after visual checks (Playwright), scheduled updates, central PHP error log viewer, monthly client reports, support for non-WP Engine hosts.

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
- [ ] **13.** Phase 1 acceptance (section 10). Only then start Phase 2.
