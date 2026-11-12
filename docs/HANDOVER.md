# Handover — UlixOps (Cursor → Claude)

Last updated: 2026-10-31. Read with `CLAUDE.md`, `docs/DEPLOY.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`.

## Live production (AWS only)

| Item                | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Provider            | **AWS EC2** (sole host — A120 / A127)                                                    |
| SSH                 | `ulixops@18.218.128.255`                                                                 |
| Deploy key (laptop) | `~/.ssh/ulixops_deploy_ed25519` (`IdentitiesOnly=yes`)                                   |
| URL                 | https://ulixops.ulixdigital.com                                                          |
| On server           | `~/ulixops`, `~/ulixops.env`                                                             |
| Compose             | `docker compose -f docker-compose.yml -f docker-compose.prod.yml` (load `~/ulixops.env`) |
| Manual deploy       | **`DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`** (no git)            |
| Live revision       | `direct-20261030T185438Z` (as of handover)                                               |
| Live data           | **30** active sites, **5** Admin users                                                   |

```sh
ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255
```

## How to ship to live (preferred — no git / no GitHub Actions)

Owner preference: **direct AWS deploy**. Do not depend on GitHub for live.

```sh
DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh
```

What it does:

1. Ensures `~/ulixops.env` on the server (generates missing hub secrets).
2. **rsync**s the local working tree over SSH (excludes `.git`, `node_modules`, `.env`, `.dev`, keys, build output).
3. Rebuilds/restarts Docker Compose on the VPS.
4. Postgres/Redis **volumes are not wiped** — sites and users stay.

Takes several minutes. Mid-deploy, Cloudflare may briefly show “This page couldn’t load” — reload after it finishes.

### Do / don’t

- **Do** run local checks before deploy: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (no `.github/` CI — A128).
- **Do** keep `DEPLOY_HOST=ulixops@18.218.128.255`.
- **Don’t** require git commit/push for live.
- **Don’t** put secrets in the synced tree; server keeps `~/ulixops.env`.
- **Don’t** run a second `cloudflared` with the live tunnel token (A126).
- Optional legacy: `scripts/deploy.sh` (git archive of committed HEAD) if a `.git` tree is present.

## Critical incident (resolved) — “only 2 sites”

**Root cause was not a Sites list bug.** A second Cloudflare Tunnel connector was online with the **same** `CLOUDFLARE_TUNNEL_TOKEN`, so Cloudflare load-balanced some requests to a stale stack (2 sites, old UI **without** Refresh list) while AWS had 30 sites and the new UI.

- Fixed (A126): only AWS may run `cloudflared` with that token.
- Sites page defenses still shipped (A122–A125): SSR `initialSites`, `GET /api/sites/list`, **Refresh list**, hub `Cache-Control` / CDN no-store.
- Sanity check after any “stale UI” report: on AWS, `cat ~/ulixops/REVISION` and site count in Postgres; in the browser, confirm **Refresh list** is visible and subtitle says **30 active sites**.

## Repo

- Local tree on `main` (GitHub remote may still exist; live does **not** use it — A124 / A128).
- **No `.github/`** — Dependabot/CI workflows removed; run checks locally, then `deploy-direct.sh`.
- **Phase 1 and Phase 2 done** (2026-10-31). **Phase 3 in progress** (Phase 3 Build Order in `docs/ROADMAP.md`): P3-1 SSL + domain expiry done 2026-10-31 (A148); P3-2 uptime monitoring done 2026-10-31 (A149). Proposed order: P3-1 SSL + domain expiry alerts → P3-2 uptime monitoring → P3-3 Cloudflare DNS management (needs an owner-created Cloudflare API token with DNS edit; give the owner exact steps when reached). Add a "Phase 3 Build Order" section to ROADMAP.md like Phase 2's, with an A-number decision row.
- Phase 1 checks not re-verified on live (ROADMAP line under step 13) are still open; they don't block Phase 3.

## Recent decisions (read full rows in `docs/DECISIONS.md`)

| #         | What                                                                     |
| --------- | ------------------------------------------------------------------------ |
| A113      | Emergency tab: inventory first; live maintenance after paint             |
| A114–A115 | Fast inventory refresh vs check-for-updates                              |
| A116–A119 | Sites Quick actions via `POST /api/sites/quick-action`                   |
| A120      | Live host = AWS EC2                                                      |
| A121      | Server Actions Origin behind Cloudflare Tunnel                           |
| A122–A125 | Sites list freshness / client fetch / SSR seed / CDN no-store            |
| A124      | Prefer `deploy-direct.sh` (no git)                                       |
| A126      | One tunnel connector only                                                |
| A127      | AWS-only docs/memory                                                     |
| A128      | No `.github/` — local checks + direct deploy                             |
| A130–A133 | Phase 2: PHP tracker, Wordfence vuln feed, API-key cards                 |
| A134      | Super Admin self-approval (granted only via server CLI)                  |
| A138–A143 | Malware scans: ClamAV + YARA scanner sidecar, Security page              |
| A144      | File integrity monitoring                                                |
| A145–A147 | Weekly encrypted backups to Google Drive; Sign in with Google            |
| A148      | Phase 3 order; SSL + domain expiry (TLS handshake + RDAP, runner)        |
| A149      | Uptime: 5-min probes on `monitor-ops` queue, down after 2 fails          |
| A150      | Site Deployments tab + real Last deploy / Last backup cards              |
| A151      | Health checks: homepage only; wp-admin opt-in (default off)              |
| A152      | Restore from Drive in the hub: approval, scope, 7-day safety copy        |
| A153      | Planned "coming soon": built-in version control, no Git (V-1…V-7)        |
| A154      | Sites table: URL under name, Host merged into tags, no wrapping          |
| A156      | P3-3 Cloudflare DNS: one scoped token, snapshots, approval rollback      |
| A157      | Restore into a chosen environment; prod ↔ staging with address change    |
| A161      | Phase 4 order: PHP errors → scheduled updates → visual → reports → hosts |
| A159/A167 | P4-1 PHP error log: UlixOps mu-plugin + private log (no wp-config)       |
| A168      | Private log as php-errors.php (exit header) for WP Engine / nginx        |
| A169      | Super Admin second-click approves stuck bulk PHP logging request         |
| A170      | readFileHead — fix "Remote output exceeds 96 bytes" on Switch logging on |
| A171      | Rich home Dashboard: ops/uptime/security charts + needs-attention        |
| A172      | Super Admin can promote Admin→Super Admin in Users UI (2FA required)     |
| A173      | Clearer restore prefix-check errors; dump grep accepts IF NOT EXISTS     |
| A174      | Cross-env restore is a full clone both ways; target domain stays         |
| A175      | New-device sign-in is notification-only (INFO, not an issue)             |
| A176      | Auto-close fixed issues + credit solver / owner                          |
| A177      | Dashboard charts for empty / text panels                                 |
| A178      | Client Viewer: one `viewTag`, tag-scoped read-only fleet                 |
| A179      | Site Files tab: SSH/SFTP browse + Admin create/edit/delete (full tree)   |
| A180      | Files: fast ls listing + optional dedicated SFTP (FileZilla-style)       |
| A181      | Files SFTP: soft auth errors + fill-from-site-SSH helper                 |
| A182      | Files SFTP password auth (sealed vault; FileZilla-style)                 |
| A183      | Files SFTP session pool (reuse sockets like FileZilla)                   |
| A160      | P4-1b PHP error logging switch: safe on/off, leak probe, bulk approval   |

Key files: `apps/web/src/app/(app)/sites/sites-page-client.tsx`, `page.tsx`, `apps/web/src/app/api/sites/list/route.ts`, `apps/web/src/proxy.ts`, `scripts/deploy-direct.sh`, Quick actions under `sites/site-quick-actions.tsx` + `api/sites/quick-action`.

## Standing owner prefs

- **No GitHub**: never push or open PRs.
- **The owner runs deploys.** Finish, run lint / format:check / typecheck / test, then tell them to run `DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`. Never deploy yourself.
- Build step by step without missing anything; proceed without asking unless a security rule blocks you.
- Read-only access to live logs/DB over SSH is approved for diagnosing problems.
- Don’t force-push / wipe GitHub history.
- Never touch real client sites from dev — use local `test-wp`.
- Only `apps/runner` opens SSH; commands from allowlist only.
- Record agent choices in `docs/DECISIONS.md`.
- Never paste private keys or `ulixops.env` into chat.

## Suggested next for Claude

### State at handover (2026-11-01, A171 rich dashboard)

- **Built, checks green, NOT deployed yet:** **A171** rich home Dashboard (ops/uptime/security charts + needs-attention), plus earlier A167–A170 PHP logging fixes. Owner runs `DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`.
- **Dashboard files:** `apps/web/src/app/(app)/page.tsx`, `apps/web/src/lib/dashboard.ts`, `apps/web/src/components/dashboard/{stat-card,charts}.tsx`.
- **Numbering:** next free decision number **A184** (check DECISIONS.md first). A183 = Files SFTP session pool.
- Checks at handover: web/api typecheck ✓.

### P4-2 Scheduled updates: what was built (A162)

- Owner-confirmed design: weekly window per site (off by default); patch + minor plugin/theme updates and WordPress **maintenance releases only** (6.8 → 6.9 is "major" in WordPress terms: listed, never automatic); staging first, production in the same window with **only the versions staging now runs**; any staging problem → production untouched; first problem stops the run; a rolled-back version is **held** until a newer one is offered or an Admin clicks Try again; switching on is **always** an ApprovalRequest (`site.autoupdate.enable`), even for one site.
- Shared `packages/shared/src/autoupdates.ts` (+ tests). API `apps/api/src/autoupdates/{service,routes}.ts`: `GET /auto-updates`, `POST /auto-updates/enable`, `GET|PUT /sites/:id/auto-updates`, `POST /sites/:id/auto-updates/disable`, `POST /sites/:id/auto-updates/holds/clear`. Run is started from the hourly tick in `monitoring/expiry.ts` (not `index.ts`). `executeBulkUpdateRun` gained `stopOnFailure` / `requireHealthyStart`; inventory refresh moved to `refreshInventory()`.
- Web: site **Plugins & themes → Scheduled updates** card; **Plugins → Scheduled updates** (`/plugins/scheduled`, also in Cmd+K).
- No runner changes (existing allowlisted jobs: inventory, snapshot, plugin/theme/core update, health, snapshot restore). Not run against local test-wp end to end: covered by Postgres integration tests with a fake runner (approval, staging → production, rollback + hold, unhealthy start, busy site, interrupted run).

### P4-4 Monthly site reports: what was built (A164 → A165)

- **One report per website** (owner-confirmed mockup). At-a-glance → severity bars + ops snapshot → issues (action + raised→fixed duration) → full ops details.
- **A166:** issues are **this site + production only** (malware, vulns, integrity, SSL/domain, PHP fatal, uptime, visual). No approvals, deploys, backups, staging, or multi-site digests. Vulns from production findings.
- Shared `packages/shared/src/reports.ts`. API `apps/api/src/reports/{aggregate,pdf,service,scheduler,routes}.ts`; `SiteReport` (migration `20261101090000`, replaces tag-based `ClientReport`); pdfkit PDF; email when `SMTP_URL` is set; 1st UTC scheduler; `report.ready`.
- Web: **Reports** (`/reports`); generate / detail / download PDF / email. Viewer: `dashboard.view`; generate/email: `settings.manage`.

### A167/A168 PHP error log via mu-plugin (P4-1b)

- **Why:** WP Engine (and similar) ignore or rewrite `WP_DEBUG*` in wp-config — switch-on via `wp config set` did not keep.
- **A168:** plain `php-errors.log` was downloadable on WP Engine (nginx ignores `.htaccess`). Log is now `ulixops-logs/php-errors.php` with a PHP `exit` header so the browser gets an empty response; leftover `.log` is deleted on switch-on.
- **Switch on:** runner writes `wp-content/mu-plugins/ulixops-error-log.php` + private log; probes URL body has no log lines; **never edits wp-config.php**.
- **Switch off:** deletes the mu-plugin only (private log kept).
- **Read:** prefers UlixOps private log when plugin or file present; else `debug.log`. UI: "by UlixOps (mu-plugin)".
- Key paths: `packages/shared/src/errorlog.ts` (`ULIXOPS_ERROR_LOG_PLUGIN_SOURCE`), `apps/runner/src/debuglog.ts` / `errorlog.ts`, `apps/api/src/errorlog/service.ts`, web Logs tab + Monitoring → PHP errors.

### Next, in this order

1. Owner deploy-direct for A167; re-switch logging on sites that need it.
2. **P4-5** support for hosts other than WP Engine (ROADMAP "Phase 4 Build Order").
3. Parked ideas: sites-list "Last backup" column; sitemap URLs for health checks; "Coming soon" built-in version control (A153, V-1…V-7).

### Owner's own to-dos (Jira ticket written for Monday 2026-11-02)

- WP Engine support: set the SSH gateway / WP-CLI PHP for install **wsiwebenhancer** to 8.4, then click **Test connection** in UlixOps.
- Remove the temporary **ulixops-diagnostics** SSH key in WP Engine (MD5 `02:37:fd:00:6b:e9:35:73:7a:26:31:d2:ff:25:89:af`), then delete `~/.ssh/ulixops_diag_wpengine_ed25519{,.pub}` on the laptop. (The auto-mode classifier blocks Claude from SSHing to client production; the owner ran the read-only commands. WP Engine's gateway strips quotes: escape `&&`, `|`, `;` with backslashes and avoid parentheses.)
- WSI Cloudflare: delete the stray root A record `23.236.60.195` (old Google Cloud / WP Engine IP) — can now be done from UlixOps DNS once WSI's Cloudflare account invites the Ulix Digital user.
- Cloudflare: invite the Ulix Digital Cloudflare user (DNS + Cache Purge roles) to each client account, add the account to the token's Zone Resources, then DNS → Refresh now (A156).
- bergerbriggs: Run health check (should be Healthy since A151), then **Resume** the paused Contact Form 7 deployment.
- Optional: Back up now for WSI (no Drive copy yet), and for WSI staging if a staging restore point is wanted.

### Open owner questions not yet answered

- None for A167. Next is P4-5 (non-WP Engine hosts) — agree host targets with the owner first.

### P2-5b restore from Drive: what was built (A152)

- Web: **Backups → Restore** (`apps/web/src/app/(app)/backups/restore/`), plus "Restore" links on Full backups rows (healthy and unhealthy sites). Admin / Super Admin only (`backups.restore`).
- API `apps/api/src/full-backups/restore.ts` (request → approval `site.backup.restore` → dispatch from the 2-minute scheduler in `malware/service.ts`, before backups) and routes in `full-backups/routes.ts`: `GET /full-backups/restores`, `POST /full-backups/restores`, `POST /full-backups/restores/:id/cancel`. Migration `20261101020000_full_restore` (`FullRestore`, `FullBackup.purpose` / `expiresAt`).
- Runner `apps/runner/src/full-restore.ts` (job `site.backup.restore`), `drive.delete` in `drive-jobs.ts`, `GoogleDrive.download`, `BackupDecryptor`, `SshSession.execUpload`.
- First live restore: try **Database only** on a staging site or a low-risk site first. A restore takes the safety copy first, so it lasts at least as long as that site's weekly backup.

### P3-2 uptime: what was built (A149)

- Runner `apps/runner/src/uptime.ts` (job `monitor.uptime`), consumed from the new **`monitor-ops`** queue by a second worker in `apps/runner/src/index.ts`; the API client routes by `queueForJob` (`packages/shared/src/queue.ts`). After deploy, runner logs should show `consuming "monitor-ops"` as well as `"remote-ops"`.
- API `apps/api/src/monitoring/uptime.ts` (scheduler every 5 min, state machine, alerts, prune) + routes in `monitoring/routes.ts`: `GET /monitoring/uptime`, `GET /sites/:id/uptime`, `POST /sites/:id/uptime-check`, `PUT /sites/:id/uptime`. Migration `20261101010000_uptime_monitoring`.
- First live check ~1 minute after the API starts; alerts need two failed checks in a row, so the earliest possible "down" alert is ~5 minutes after that.
- If live shows "Every site failed at once": the runner can't reach the internet (egress network), not the sites.

### P3-2 uptime: original plan notes (kept for context)

- Spec: screen 16 "uptime per site, response time, … incident history"; sites list "uptime" column; dashboard "Sites down" stat (placeholder "Monitoring · Phase 3" in `apps/web/src/app/(app)/page.tsx`).
- Copy the P3-1 shape: `packages/shared/src/monitoring.ts` (add contracts + tests), a runner job next to `monitor.expiry` in `packages/shared/src/queue.ts` / `apps/runner/src/jobs.ts` (HTTP probes run on the runner: only it has egress; reuse the public-host rule `isPublicHostname` and the health-check fetch/redirect code in `apps/runner/src/health.ts`), API module beside `apps/api/src/monitoring/expiry.ts` + `routes.ts` (already mounted at `/monitoring` and `/sites/:id/...`, `/monitoring` is in `SIGNED_IN_PATHS`).
- UI: add an "Uptime" tab to `apps/web/src/app/(app)/monitoring/monitoring-tabs.tsx` and make `/monitoring` show it (it currently redirects to `/monitoring/ssl`); replace the "Uptime" placeholder card on the site **Uptime & SSL** tab (`sites/[id]/(detail)/monitoring/page.tsx`).
- Decide and record (A149): check interval (every few minutes, one batched runner job for all sites keeps queue load low), how many failures in a row = down (avoid alert noise), down/up alerts (new `NotificationEvent`s in `packages/shared/src/notifications.ts`; prefs merge automatically), incident rows + retention of probe samples, audit of incidents/settings. Runner jobs older than 60 s are refused (A49), so a schedule must enqueue fresh jobs.
- Local test sites are dev hosts (`localhost`, `test-wp`): uptime probing of them is fine (it's our container), unlike public-only expiry checks, but never probe real client sites from dev/tests (stub the runner in API tests, fake fetch in runner tests).

### P3-3 Cloudflare DNS

Needs an owner-created Cloudflare API token scoped to **DNS edit only** (spec §5); give the owner exact steps when reached, store it via the Settings → Credentials approval + sealed flow (A133). Record edits/rollbacks are mutating and site-affecting: audit every change; bulk changes need an ApprovalRequest.

### Practical notes

1. Local production builds stall on the NTFS drive: rsync the repo to the scratchpad (exclude node_modules, .git, .next, dist, `apps/api/src/generated`) and run `docker compose -p ulixops -f docker-compose.yml -f docker-compose.dev.yml build api runner web migrate` there. Build **migrate** too, or new migrations don't apply locally.
2. Behind the tunnel `req.url` is `0.0.0.0:3000`: route handlers must redirect with relative paths (A147). Large uploads go through route handlers, not Server Actions (A141).
3. Error codes the API returns must be added to `AuthErrorCode` (`packages/shared/src/auth.ts`), the status map in `apps/api/src/auth/routes.ts` and `apps/web/src/lib/messages.ts`.
