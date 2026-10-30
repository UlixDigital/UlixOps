# UlixOps — Phase 1 Build Spec

- [ ]

  ## 0. Instructions for AI Coding Agents (read first)

  This document is the single source of truth for UlixOps. If you are an AI coding agent (Claude Code or similar), follow these rules exactly.
  1. **Read the whole document before writing any code.** Do not skip sections. Section 13 (Decisions Log) records final decisions; do not reopen them.
  2. **Bootstrap the repo first.** Before any feature work, create these files from this document:
     - `CLAUDE.md`: project summary, stack, rules, commands (template in section 14.1).
     - `docs/SPEC.md`: this full document, unchanged.
     - `docs/ARCHITECTURE.md`: section 4 + the runner/API boundary.
     - `docs/SECURITY.md`: section 5 in full + section 12 (FTP rules).
     - `docs/UI.md`: sections 3a and 3b.
     - `docs/ROADMAP.md`: section 2 + section 11 (build order) as a checklist.
     - `docs/DECISIONS.md`: section 13.
     - `docs/BREAK-GLASS.md`: emergency manual-access procedure.
     - `.claude/rules/security.md`, `.claude/rules/coding.md`, `.claude/rules/ui.md`: short, enforceable rules from sections 5, 9 and 3a.
     - `.env.example` (variable NAMES only, section 14.4), `docker-compose.yml`, `README.md`.
  3. **Build in the order of section 11.** Finish and test one step before the next. Stop and summarise after each step.
  4. **Never weaken security** to make something work. If a requirement in section 5 blocks you, stop and ask.
  5. **Never invent requirements.** If something is not specified, choose the simplest secure option and record it in `docs/DECISIONS.md` as "agent decision".
  6. **Never put secrets in code, logs, commits or the frontend.**
  7. **Ask before** touching a real client site. Use the local test WordPress container or the designated test site only.

  ### Project at a glance
  - **Owner:** Ulix Digital (web development agency).
  - **Problem:** \~27 WordPress sites across several hosts; recent PHP vulnerability issues; risky manual plugin updates; when an update breaks a site, wp-admin is unreachable.
  - **Solution:** UlixOps, a private, highly secure central hub that manages all sites at server level (SSH/SFTP + WP-CLI): deploy custom plugins to many sites, staging-first and phased, with quick snapshots, health checks and automatic rollback; later vulnerability scanning, Google Drive backups, Cloudflare DNS, monitoring and reports.
  - **First target:** WP Engine-hosted sites. Other hosts later.
  - **Language:** TypeScript only (no PHP in the hub).

  ## 1. Overview

**UlixOps** is Ulix Digital's secure central hub for managing all of its WordPress sites (\~27) from one place. It connects to each site over SSH/SFTP (not wp-admin), so the team can push custom plugins and updates to many sites at once, with quick pre-update snapshots, staging-first rollouts, health checks and one-click / automatic rollback. Later phases add vulnerability scanning, Cloudflare DNS management, monitoring and client reporting.

Security of the hub itself is the top priority: a compromised hub would expose every managed site.

**Why server-level access:** if a plugin update crashes a site, wp-admin is unreachable. SSH/SFTP + WP-CLI still works, so the hub can always deactivate, roll back or repair.

## 2. Phased Roadmap

- **Phase 1 (this spec):** secure foundation, auth & roles, site registry, SSH/WP-CLI connector, custom plugin registry, staged + phased deployments, pre-update snapshots, health checks, rollback, audit log, notifications. Target: WP Engine sites first.
- **Phase 2:** vulnerability scanning (Wordfence Intelligence feed + Wordfence CLI), PHP version tracker, file integrity monitoring, scheduled encrypted backups to Google Drive.
- **Phase 3:** Cloudflare DNS management (migration, editing, snapshots, change alerts), SSL & domain expiry alerts, uptime monitoring.
- **Phase 4:** before/after visual checks (Playwright), scheduled updates, central PHP error log viewer, monthly client reports, support for non-WP Engine hosts.

Build Phase 1 so that later phases plug in cleanly (modular services, shared job queue, shared audit log).

## 3. Tech Stack

- **Language:** TypeScript everywhere (strict mode).
- **Frontend:** Next.js (App Router) + React, Tailwind CSS, shadcn/ui.
- **Backend:** Node.js (LTS) API — NestJS or Express with Zod validation on every input.
- **Database:** PostgreSQL with Prisma ORM (migrations versioned in repo).
- **Job queue:** Redis + BullMQ for deployments, snapshots, health checks.
- **SSH/SFTP:** `ssh2` / `ssh2-sftp-client`; WP-CLI executed remotely.
- **Secrets:** Infisical (or equivalent vault). Never in code, `.env` committed files, or plain DB columns.
- **Hosting:** private VPS (DigitalOcean / Hetzner / AWS) running Docker Compose, behind Cloudflare Zero Trust.
- **Testing:** Vitest (unit), Playwright (e2e).

## 3a. UI & Design

The UI is modern and minimal but not colourful: a clean, standard admin dashboard in the style of Vercel, Linear or Stripe.

- **Palette:** neutral greys (zinc/slate), white and near-black surfaces; ONE accent colour taken from the Ulix Digital brand: primary blue approx. #2563EB (hover/dark #1E40AF, deep navy #0B2A6F for the dark-mode sidebar), used for primary buttons, active nav, links and focus rings. Hex values are estimated from website screenshots; confirm against the brand file. Colour otherwise used only for status (green success, amber warning, red error), kept muted.
- **Themes:** light and dark mode, following the system setting with a manual toggle.
- **Components:** shadcn/ui on Tailwind CSS, lucide-react icons, Inter (or Geist) font. No gradients, heavy shadows or decorative illustrations.
- **Layout:** collapsible left sidebar (Dashboard, Sites, Plugins, Deployments, Backups, Audit Log, Settings), top bar with search (Cmd+K command palette) and user menu, content in cards and data tables.
- **Data tables:** sortable, filterable, with bulk-select for multi-site actions (TanStack Table).
- **Status:** small badges and progress indicators for job states; live deployment progress per site.
- **Feedback:** toast notifications, confirmation dialogs for destructive or bulk actions, skeleton loaders, clear empty states.
- **Quality:** fully responsive, keyboard accessible, WCAG AA contrast, subtle animations only (fades/transitions under 200 ms).

&#91;embedded content: UlixOps dashboard mock-up · sidebar, stats, live phased rollout\]

Dashboard layout to build: left sidebar navigation, top search bar, stat cards, and a live deployment table showing staging, phased batches, automatic rollback and pause. Values shown as — are placeholders filled from real data.

## 3b. Screens (full list)

Every screen uses the layout above (sidebar + top bar). Phase in brackets; build Phase 1 screens fully, show later-phase menu items as "Coming soon".

1. **Login + 2FA** \[P1\]: email/password, then TOTP or passkey. New-device alert, lockout after failed attempts, session-expired screen.
2. **Dashboard** \[P1\]: stat cards (sites, vulnerabilities, updates pending, last backup, sites down), live deployments, approvals waiting, recent alerts, recent audit events.
3. **Sites list** \[P1\]: table with name, URL, host, client/tag, WP version, PHP version, plugin updates, vulnerability count, last backup, uptime, health badge. Filters, search, bulk-select (deploy, update, snapshot, scan). Add site button.
4. **Add / edit site** \[P1\]: name, URL, host (WP Engine / other), production + staging details, SSH host/user/port, WP path, credential picked from vault, tags/client. Test connection button with results (SSH, WP-CLI, WP and PHP versions).
5. **Site detail** \[P1\], tabs:
   - Overview: versions, active theme, health, last deploy, last backup.
   - Plugins & themes: installed list with versions, update / activate / deactivate.
   - Deployments: history for this site.
   - Snapshots & backups: list with restore button.
   - Emergency: deactivate plugin, maintenance mode on/off, flush cache, roll back last change (works when wp-admin is down).
   - Logs: PHP error log viewer \[P4\], job logs \[P1\].
   - Security \[P2\], DNS \[P3\], Uptime & SSL \[P3\], Visual checks \[P4\].
6. **Plugin registry** \[P1\]: Ulix Digital custom plugins, latest version, number of sites on latest vs outdated.
7. **Upload plugin version** \[P1\]: drag-and-drop ZIP, version, changelog, "changes database" checkbox, checksum shown, validation result.
8. **Plugin detail** \[P1\]: version history and a site-by-version matrix; "update outdated sites" button.
9. **Deploy wizard** \[P1\], steps: choose plugin + version, choose sites (filters, bulk), rollout settings (staging first on/off, batch size, pause on failure, schedule now / later \[P4\]), review, then submit (sends approval request when bulk).
10. **Deployment live view** \[P1\]: per-site steps (queued, snapshot, staging, health check, deploying, done, rolled back, failed), live job log, pause / resume / cancel, manual rollback per site.
11. **Deployments history** \[P1\]: all deployments with who, when, plugin, sites, result; filter and export.
12. **Approvals** \[P1\]: pending requests with details, approve / reject with comment (requester cannot approve their own).
13. **Backups & snapshots** \[P1 snapshots, P2 scheduled\]: quick snapshots with expiry, scheduled full backups to Google Drive, schedule settings, retention, restore, "last tested restore" date.
14. **Security** \[P2\]: vulnerability list across all sites (severity, plugin/theme/core, affected sites, fixed version, one-click update), Wordfence CLI malware scan results, PHP version tracker, file integrity alerts.
15. **DNS** \[P3\]: Cloudflare domains, records table with add/edit/delete, snapshot + rollback of records, change alerts, migration checklist per domain, cache purge.
16. **Monitoring** \[P3\]: uptime per site, response time, SSL expiry, domain expiry, incident history.
17. **Visual checks** \[P4\]: before/after screenshots with diff highlight per deployment.
18. **Reports** \[P4\]: monthly per-client report (updates, backups, security, uptime), PDF export and email.
19. **Notifications** \[P1\]: in-app alert centre; settings for email / Slack per event type.
20. **Audit log** \[P1\]: searchable, filter by user, site, action, date; export; read-only.
21. **Users & roles** \[P1\]: invite user, set role (Admin / Developer / Viewer), force 2FA reset, deactivate, active sessions with revoke.
22. **Settings** \[P1\]: integrations (WP Engine API, Cloudflare token \[P3\], Google Drive \[P2\], Slack), vault connection status, credential rotation reminders, IP allowlist, session timeout, snapshot retention, health-check URLs and thresholds.
23. **My account** \[P1\]: profile, 2FA / passkeys, active sessions.
24. **Break-glass guide** \[P1\]: read-only page (also in README) with emergency manual-access steps if UlixOps is down.

## 4. Architecture

- **Web app (Next.js):** dashboard UI only; talks to the API.
- **API service:** auth, RBAC, business logic, writes jobs to the queue. Never opens SSH connections itself.
- **Isolated runner (worker):** separate container that consumes BullMQ jobs and is the *only* component allowed to fetch SSH credentials and connect to sites. Minimal permissions, no public ports.
- **PostgreSQL:** sites, users, deployments, snapshots, audit log.
- **Redis:** queue + rate limiting.
- **Vault:** SSH private keys and API tokens, fetched at job time with short TTL.

All services on a private Docker network; only the web app is exposed, and only through Cloudflare Zero Trust.

## 5. Security Requirements (non-negotiable)

### Access

- Hub never publicly reachable: Cloudflare Zero Trust (Access) in front, plus IP allowlisting (office/VPN IPs).
- Mandatory 2FA (TOTP; WebAuthn/passkeys preferred) for every user.
- Session timeout (e.g. 30 min idle, 12 h absolute); secure, httpOnly, SameSite=strict cookies.
- New-device / new-location login alerts to admins.
- Login rate limiting and account lockout.

### Roles (RBAC)

- **Admin:** full access; manages users, sites, secrets; approves risky actions.
- **Developer:** can deploy to staging and single sites; bulk/production-wide pushes require Admin approval.
- **Viewer:** read-only dashboards and reports.

### Approval workflow

- Risky actions (bulk deploy, rollout to all sites, deleting a site, credential changes) require a second person (Admin) to approve. Requester cannot approve their own request.

### Secrets & credentials

- SSH key auth only (no passwords). Keys stored in the vault, encrypted at rest.
- Support short-lived / rotating credentials; rotation reminders and one-click rotation.
- Scoped API tokens only (e.g. Cloudflare DNS-edit-only in Phase 3).
- Secrets never logged, never returned to the frontend.

### Application security

- Validate all input with Zod; parameterised queries only (Prisma).
- **No shell injection:** never interpolate user input into remote commands. Build WP-CLI commands from an allowlist of operations with strictly validated arguments (slugs, versions).
- Uploaded plugin ZIPs: size limit, MIME + structure check, SHA-256 checksum stored, scanned before use, stored outside web root.
- CSRF protection, strict CSP, security headers (HSTS, X-Frame-Options, etc.).
- Dependency scanning (npm audit / Dependabot) and lockfile pinned.
- Least privilege for every container and DB user.

### Audit log

- Append-only record of every action: who, what, which site(s), when, from which IP, result.
- Alerts on unusual activity (e.g. bulk actions out of hours, repeated failed logins).

### Break-glass

- Documented emergency procedure if UlixOps is down: offline-stored admin credentials and direct SSH access path, so sites can still be managed manually.
- Hub's own database backed up daily, encrypted.

## 6. Phase 1 Features

### 6.1 Site registry

- Add / edit / archive sites: name, URL, host (WP Engine first), environment(s) (production, staging), SSH host/user/port, WP path, credential reference (vault ID), tags/client.
- "Test connection" button: verifies SSH, WP-CLI availability, WP version, PHP version.
- Site overview: WP core version, PHP version, active theme, installed plugins + versions (pulled via WP-CLI).

### 6.2 SSH / WP-CLI connector (runner only)

- Supported operations (allowlist): list plugins/themes, install/update/activate/deactivate plugin, core version, PHP version, maintenance mode on/off, cache flush, DB export/import.
- WP Engine: connect through the WP Engine SSH Gateway (WP-CLI preinstalled).
- Timeouts, retries and full command output captured to the job log (with secrets redacted).

### 6.3 Custom plugin registry

- Upload Ulix Digital's own plugins as ZIPs; store versions with changelog and checksum.
- Track which version of each custom plugin is installed on which site.
- Show sites running outdated versions.

### 6.4 Deployment workflow (staging-first + phased)

1. Select plugin + version and target sites.
2. **Approval** if bulk/production-wide.
3. **Staging:** deploy to each site's staging environment (where available) → run health checks.
4. **Production, phased:** deploy to a small first batch (e.g. 1–2 sites) → health checks → if pass, continue to remaining sites in batches.
5. Before each site's update: take a **quick pre-update snapshot**.
6. After each site's update: run **health checks**; on failure → **automatic rollback** of that site and pause the rollout.

- Live job progress view per site (queued / snapshot / deploying / checking / done / rolled back / failed).
- Hosts without staging skip step 3 and go straight to phased production rollout.

### 6.5 Quick pre-update snapshots

- Zip only the affected plugin's folder (fast, seconds).
- Also export the database when the update is flagged as DB-changing (or for major versions).
- Store snapshots encrypted; auto-delete after a retention period (default 7 days, configurable).
- Scheduled full backups are separate (Phase 2, Google Drive).

### 6.6 Health checks

- HTTP status of homepage + configurable key URLs (expect 200).
- Look for PHP fatal errors / "critical error" page text in the response.
- Check `wp-admin` login page loads.
- Check recent PHP error log entries for new fatals (where accessible).
- Response-time threshold.

### 6.7 Rollback

- One-click manual rollback from any snapshot.
- Automatic rollback when health checks fail: restore plugin folder (and DB if exported), flush cache, re-run health checks, notify team.
- Emergency action: deactivate a plugin via WP-CLI when wp-admin is down.

### 6.8 Notifications

- Email (and Slack webhook, optional) for: deployment started/finished, failures, automatic rollbacks, approval requests, security alerts.

## 7. Data Model (initial)

- `User` (role, 2FA, status)
- `Site` (url, host, environments, credentialRef, tags)
- `SiteSnapshot` (site inventory: WP/PHP versions, plugins — refreshed on demand)
- `Plugin` / `PluginVersion` (zip location, checksum, changelog, dbChanging flag)
- `Deployment` (plugin version, targets, status, requestedBy, approvedBy)
- `DeploymentTarget` (per-site status, logs)
- `Backup` (type: quick snapshot / full, location, expiresAt)
- `ApprovalRequest`
- `AuditLog` (append-only)

## 8. Later-Phase Notes (for context, not Phase 1)

- **Vulnerability scanning:** inventory versions via WP-CLI and match against the Wordfence Intelligence vulnerability feed (or WPScan / Patchstack); run Wordfence CLI over SSH for malware. Wordfence plugin can stay on each site for firewall only.
- **Backups:** scheduled, encrypted full backups uploaded to the team's Google Drive via service account, folder per site, retention rules.
- **DNS:** migrate all domains to Cloudflare; hub reads/edits records via scoped API token; snapshot records before every change; alert on unexpected changes; purge cache after deploys.
- **Monitoring:** uptime, SSL and domain expiry, PHP version tracker, file integrity monitoring.
- **Visual checks:** Playwright before/after screenshots and diffing (can reuse the existing audit tool approach).
- **Reports:** monthly per-client update and security reports.

## 9. Coding Standards & Delivery

- Monorepo (e.g. `apps/web`, `apps/api`, `apps/runner`, `packages/shared`).
- TypeScript strict, ESLint + Prettier, no `any`.
- Every remote operation behind a typed, tested service function.
- Unit tests for command building, RBAC and approval logic; e2e test for the full deploy → fail → rollback path (against a test WordPress container).
- Docker Compose for local dev, including a disposable WordPress + MySQL test site with SSH and WP-CLI.
- README with setup, environment variables (names only), and break-glass procedure.

## 10. Phase 1 Acceptance Criteria

- Hub only reachable via Zero Trust + allowlisted IPs; all users must use 2FA.
- Admin can register a WP Engine site and pass "Test connection".
- Developer can upload a custom plugin and deploy it to staging, then (with Admin approval) roll it out in phases to multiple production sites.
- A quick snapshot exists before every site update and expires per retention rule.
- A deliberately broken plugin triggers failed health checks, automatic rollback, rollout pause and a notification.
- Every action appears in the audit log; no secret ever appears in logs or the UI.

## 11. Build Order (follow step by step)

**Step 0, before coding (human tasks):** provision VPS; set up Cloudflare Zero Trust; set up the secrets vault; get WP Engine SSH Gateway access + API credentials; pick ONE low-risk test site; create Slack webhook / SMTP.

1. Repo bootstrap: all files from section 0, monorepo skeleton, Docker Compose (web, api, runner, postgres, redis, test WordPress with SSH + WP-CLI), CI with lint, type-check, tests, dependency audit.
2. Auth: login, mandatory 2FA, sessions/timeouts, lockout, new-device alerts.
3. RBAC (Admin / Developer / Viewer) + append-only audit log.
4. Users & roles screen, My account, Settings skeleton, IP allowlist.
5. Site registry + vault-backed credentials + Test connection (runner only).
6. Site detail: inventory via WP-CLI, plugins & themes, emergency actions.
7. Plugin registry + secure ZIP upload + version tracking.
8. Quick pre-update snapshots + retention.
9. Health checks.
10. Deploy wizard + approvals + staging-first + phased rollout + automatic rollback + live view.
11. Notifications (email, Slack, in-app).
12. Hardening pass: security review against section 5, e2e test of deploy, fail, rollback using a deliberately broken plugin on the test site.
13. Phase 1 acceptance (section 10). Only then start Phase 2.

## 12. Connection Methods & Non-WP-Engine Fallback

- **Preferred:** SSH with key auth + WP-CLI.
- **SFTP-only hosts (no WP-CLI):** the runner still works by files: download the plugin folder as the snapshot (zip), upload and swap the new folder (upload to a temp name, then rename), and roll back by restoring the zipped folder. Deactivating a broken plugin without WP-CLI = rename its folder (WordPress then deactivates it). DB export needs SSH or a host API; if unavailable, mark the site "no DB rollback" and require staging or a full backup for DB-changing updates.
- **Plain FTP:** last resort only, because it sends passwords unencrypted. Prefer FTPS (FTP over TLS). Plain FTP sites are flagged "insecure connection" in the UI, require Admin to enable, and should be migrated to SFTP.
- **WP Engine:** SSH Gateway (WP-CLI preinstalled), staging environments, and the WP Engine API to trigger a full backup before major / DB-changing updates, in addition to quick snapshots.

## 13. Decisions Log (final)

| Topic | Decision |
| --- | --- |
| Name | UlixOps (for Ulix Digital) |
| Access to sites | Server level (SSH/SFTP, FTP last resort), never relying on wp-admin |
| Core feature | Upload custom plugins, deploy to many sites, undo on failure |
| Staging | Included: staging first where the host supports it, then phased production rollout |
| Pre-update backup | Quick snapshot (plugin folder + DB export when needed), not full backups; 7-day retention |
| Full backups | Scheduled, encrypted, stored in Ulix Digital's Google Drive (main location) |
| Vulnerability scanning | Not the Wordfence plugin on the hub (it only scans its own site). WP-CLI inventory matched against Wordfence Intelligence feed + Wordfence CLI over SSH. Wordfence plugin may stay on sites as firewall |
| DNS | Migrate all domains to Cloudflare; manage via scoped API token |
| Language / stack | TypeScript; Next.js + React; Node.js API; PostgreSQL + Prisma; Redis + BullMQ; Playwright |
| Hosting | Own VPS, Docker, behind Cloudflare Zero Trust; secrets in Infisical |
| Roles | Admin, Developer, Viewer; 2FA for all; second-person approval for risky actions |
| UI | Modern, minimal, not colourful; neutral greys + Ulix blue accent; light + dark mode |
| First rollout | WP Engine sites first, other hosts later |

## 14. Code Reference

### 14.1 CLAUDE.md template

```markdown
# UlixOps
Secure central hub for Ulix Digital's WordPress sites. Full spec: docs/SPEC.md (source of truth).

## Stack
TypeScript (strict) monorepo: apps/web (Next.js), apps/api (Node), apps/runner (BullMQ worker), packages/shared.
PostgreSQL + Prisma, Redis + BullMQ, Tailwind + shadcn/ui, Vitest, Playwright.

## Non-negotiable rules
- Only apps/runner may fetch credentials or open SSH/SFTP connections.
- Remote commands come ONLY from the allowlist in packages/shared/src/commands.ts. Never interpolate raw input.
- Validate every input with Zod. No `any`.
- Never log or return secrets. Redact command output.
- Every mutating action writes an AuditLog row.
- Bulk / all-sites actions require an approved ApprovalRequest.
- Never touch real client sites in dev/tests; use the local test WordPress container.
- Follow docs/ROADMAP.md order; update it when a step is done.

## Commands
pnpm dev | pnpm test | pnpm lint | pnpm typecheck | pnpm db:migrate
```

### 14.2 Safe WP-CLI command builder (pattern)

```ts
// packages/shared/src/commands.ts
import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9-]{1,100}$/);
const version = z.string().regex(/^[0-9a-zA-Z.\-]{1,30}$/);

export const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plugin.list") }),
  z.object({ op: z.literal("plugin.deactivate"), slug }),
  z.object({ op: z.literal("plugin.activate"), slug }),
  z.object({ op: z.literal("core.version") }),
  z.object({ op: z.literal("maintenance"), on: z.boolean() }),
  z.object({ op: z.literal("cache.flush") }),
  z.object({ op: z.literal("db.export"), file: z.string().regex(/^\/tmp\/ulixops-[a-z0-9-]+\.sql$/) }),
]);
export type Command = z.infer<typeof Command>;

// Returns an argv array (never a shell string). The runner passes args safely.
export function toArgv(input: unknown): string[] {
  const c = Command.parse(input);
  switch (c.op) {
    case "plugin.list": return ["wp", "plugin", "list", "--format=json"];
    case "plugin.deactivate": return ["wp", "plugin", "deactivate", c.slug];
    case "plugin.activate": return ["wp", "plugin", "activate", c.slug];
    case "core.version": return ["wp", "core", "version"];
    case "maintenance": return ["wp", "maintenance-mode", c.on ? "activate" : "deactivate"];
    case "cache.flush": return ["wp", "cache", "flush"];
    case "db.export": return ["wp", "db", "export", c.file];
  }
}
```

### 14.3 Prisma schema (starting point)

```prisma
enum Role { ADMIN DEVELOPER VIEWER }
enum Host { WPENGINE OTHER }
enum Conn { SSH SFTP FTPS FTP }
enum TargetStatus { QUEUED SNAPSHOT STAGING CHECKING DEPLOYING DONE ROLLED_BACK FAILED PAUSED }

model User {
  id String @id @default(cuid())
  email String @unique
  role Role @default(VIEWER)
  twoFactorEnabled Boolean @default(false)
  active Boolean @default(true)
  createdAt DateTime @default(now())
}

model Site {
  id String @id @default(cuid())
  name String
  url String @unique
  host Host
  connection Conn @default(SSH)
  sshHost String
  sshUser String
  sshPort Int @default(22)
  wpPath String
  stagingUrl String?
  credentialRef String // vault ID only, never the secret
  tags String[]
  archived Boolean @default(false)
  targets DeploymentTarget[]
  backups Backup[]
}

model Plugin {
  id String @id @default(cuid())
  slug String @unique
  name String
  versions PluginVersion[]
}

model PluginVersion {
  id String @id @default(cuid())
  pluginId String
  plugin Plugin @relation(fields: [pluginId], references: [id])
  version String
  sha256 String
  storageKey String
  changelog String
  dbChanging Boolean @default(false)
  createdAt DateTime @default(now())
  @@unique([pluginId, version])
}

model Deployment {
  id String @id @default(cuid())
  pluginVersionId String
  requestedById String
  approvedById String?
  stagingFirst Boolean @default(true)
  batchSize Int @default(2)
  status String
  createdAt DateTime @default(now())
  targets DeploymentTarget[]
}

model DeploymentTarget {
  id String @id @default(cuid())
  deploymentId String
  deployment Deployment @relation(fields: [deploymentId], references: [id])
  siteId String
  site Site @relation(fields: [siteId], references: [id])
  status TargetStatus @default(QUEUED)
  log String @default("")
}

model Backup {
  id String @id @default(cuid())
  siteId String
  site Site @relation(fields: [siteId], references: [id])
  kind String // QUICK_SNAPSHOT | FULL
  location String
  encrypted Boolean @default(true)
  expiresAt DateTime?
  createdAt DateTime @default(now())
}

model ApprovalRequest {
  id String @id @default(cuid())
  action String
  payload Json
  requestedById String
  decidedById String?
  status String @default("PENDING")
  createdAt DateTime @default(now())
}

model AuditLog {
  id String @id @default(cuid())
  userId String?
  action String
  siteIds String[]
  ip String?
  result String
  meta Json?
  createdAt DateTime @default(now())
  // append-only: DB role has INSERT/SELECT only on this table
}
```

### 14.4 Environment variables (names only)

```csv
name,purpose
DATABASE_URL,PostgreSQL connection
REDIS_URL,BullMQ queue
SESSION_SECRET,session signing (from vault)
INFISICAL_CLIENT_ID,vault access (runner + api)
INFISICAL_CLIENT_SECRET,vault access
WPENGINE_API_USER,WP Engine API
WPENGINE_API_PASSWORD,WP Engine API
SMTP_URL,email notifications
SLACK_WEBHOOK_URL,Slack notifications (optional)
GOOGLE_DRIVE_SA_JSON_REF,vault ref for Drive service account (Phase 2)
CLOUDFLARE_API_TOKEN_REF,vault ref for DNS-scoped token (Phase 3)
ALLOWED_IPS,IP allowlist
SNAPSHOT_RETENTION_DAYS,default 7
```

### 14.5 First prompt to paste into Claude Code

```markdown
Read docs/SPEC.md (this document) completely. Then do section 0, step 2: create CLAUDE.md, all docs/ files, .claude/rules/ files, .env.example, docker-compose.yml and README.md exactly as specified. Then complete Build Order step 1 only. Stop, summarise what you created, and list any agent decisions you recorded.
```
