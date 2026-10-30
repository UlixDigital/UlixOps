# Security

Source: docs/SPEC.md section 5 (in full) and section 12 (connection methods and FTP rules). These requirements are non-negotiable. If one blocks progress, stop and ask; never weaken it.

## Security Requirements (spec section 5)

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

See docs/BREAK-GLASS.md for the procedure.

## Connection Methods & Non-WP-Engine Fallback (spec section 12)

- **Preferred:** SSH with key auth + WP-CLI.
- **SFTP-only hosts (no WP-CLI):** the runner still works by files: download the plugin folder as the snapshot (zip), upload and swap the new folder (upload to a temp name, then rename), and roll back by restoring the zipped folder. Deactivating a broken plugin without WP-CLI = rename its folder (WordPress then deactivates it). DB export needs SSH or a host API; if unavailable, mark the site "no DB rollback" and require staging or a full backup for DB-changing updates.
- **Plain FTP:** last resort only, because it sends passwords unencrypted. Prefer FTPS (FTP over TLS). Plain FTP sites are flagged "insecure connection" in the UI, require Admin to enable, and should be migrated to SFTP.
- **WP Engine:** SSH Gateway (WP-CLI preinstalled), staging environments, and the WP Engine API to trigger a full backup before major / DB-changing updates, in addition to quick snapshots.

## How the repo enforces this today (through Build Order step 8)

| Requirement                          | Where                                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only the runner opens SSH/SFTP       | ESLint `no-restricted-imports` blocks `ssh2`, `ssh2-sftp-client` and `child_process` outside `apps/runner`; runner has no DB access (docs/ARCHITECTURE.md).                                                                                                           |
| Allowlisted remote commands          | `packages/shared/src/commands.ts` + tests for injection attempts. Plugin names can never start with `-` (A6, A53); users pick an action, never a command (`SiteActionRequest`).                                                                                       |
| No `any`                             | ESLint `@typescript-eslint/no-explicit-any: error`.                                                                                                                                                                                                                   |
| Security headers / CSP               | API: helmet (`default-src 'none'`). Web: per-request nonce CSP in `apps/web/src/proxy.ts`, plus HSTS, frame, referrer and permissions headers in `next.config.ts`.                                                                                                    |
| Dependency scanning, pinned lockfile | `pnpm install --frozen-lockfile` and `pnpm audit:deps` run locally before each deploy (no hosted CI/Dependabot, A128).                                                                                                                                                |
| Least-privilege containers           | docker-compose.yml: non-root users, read-only root FS, `cap_drop: ALL`, `no-new-privileges`, segmented internal networks.                                                                                                                                             |
| No secrets in the repo               | `.env`, `.dev/` and `.vscode/sftp.json` are git-ignored; `.env.example` holds names only.                                                                                                                                                                             |
| Mandatory 2FA                        | No session exists until TOTP is set up; every sign-in needs password + a single-use TOTP code or a passkey (A24, A45).                                                                                                                                                |
| Passkeys                             | WebAuthn second factor; adding one needs the current TOTP code; origin/RP ID, challenge and signature counter verified (A45).                                                                                                                                         |
| Session timeout, secure cookies      | 30 min idle / 12 h absolute enforced by the API; `__Host-` Secure, HttpOnly, SameSite=Strict cookies (A25).                                                                                                                                                           |
| Rate limiting and lockout            | Redis: 30 auth calls per IP per 15 min; 5 failures lock the email for 15 min; identical errors for unknown accounts (A29).                                                                                                                                            |
| New-device alerts                    | `SecurityAlert` row + audit row for every unknown device after the first; email/Slack delivery in step 11 (A26).                                                                                                                                                      |
| Secrets at rest                      | Passwords: argon2id. Tokens: only HMAC-SHA256 stored. TOTP secrets: AES-256-GCM bound to the user (A23–A25).                                                                                                                                                          |
| CSRF                                 | Server Actions (Origin check, POST only) + SameSite=Strict (A28).                                                                                                                                                                                                     |
| Append-only audit log                | The API's DB role has only SELECT/INSERT on `AuditLog`, and a trigger blocks UPDATE/DELETE for every role. Auth events and refusals are recorded with the IP (A30, A32).                                                                                              |
| RBAC                                 | One permission map (`packages/shared/src/rbac.ts`) enforced by the API on every route; refusals return 403 and are audited (A33, A35).                                                                                                                                |
| Second-person approval               | `canDecideApproval`: Admins only, never their own request (A34). A new SSH key, server, port or user for a site and forgetting a pinned host key wait for another Admin; a request applies only if the site hasn't changed since (A47). Bulk deploys join in step 10. |
| Secrets vault                        | SSH keys in self-hosted Infisical, reachable only from the runner's network; the runner's identity has 5-minute tokens; the API holds no vault login (A46). Keys are generated in the runner and only the public key is shown (A50).                                  |
| SSH host verification                | First successful Test connection pins the server's SHA-256 host key; a mismatch refuses to connect and alerts Admins (A47).                                                                                                                                           |
| Output redaction                     | Runner strips private-key blocks and the key in use from command output and errors, and caps their length, before anything leaves it (A49).                                                                                                                           |
| Least-privilege DB user              | API connects as `ulixops_app` (no DDL, no migration table); owner login only in the one-shot migrate service (A32).                                                                                                                                                   |
| IP allowlisting                      | Web proxy enforces the Admin list plus `ALLOWED_IPS` before anything is served; anti-lockout check on save; trusted IP only via `CLIENT_IP_HEADER` (A27, A40).                                                                                                        |
| Account administration               | Self-change and last-Admin protection; alerts on new Admins and 2FA resets; deactivation and resets end sessions (A39).                                                                                                                                               |

| Single-site actions | Inventory, plugin activate/deactivate, maintenance mode and cache flush run only on a pinned host key, one at a time per environment (an atomic claim, A60), each recorded as a job log entry with redacted output and an audit row; role checked per action and environment (A55, A58).

| Plugin ZIP uploads | Up to 10 MB; type checked by content; strict in-memory ZIP reader (no ZIP64, encryption, overlap, traversal, links); every file unpacked and CRC-checked; secrets, server config and executables refused; SHA-256 stored; quarantined until saved, then stored by checksum in a volume outside any web root (A61–A63). |

| Quick snapshots | Runner SFTP-downloads the plugin folder (validated under `wpPath`), optional `db.export`, zips locally, encrypts with AES-256-GCM (`SNAPSHOT_ENCRYPTION_KEY`, AAD = Backup id) into `snapshot-store`; API deletes expired files only and never holds the key (A67–A69, A71). Restore and snapshot-first `plugin.update` are audited (A72–A74). |

Hardening (step 12): site archive needs a second Admin (A91); deploy orchestrator outcomes are audited (A92); empty first-install snapshots (A90); hub DB backup script (A93); out-of-hours bulk deploy audited (A95). Still ops/human or later phases: Cloudflare Access policies, SFTP-only / FTP hosts, one-click key rotation, malware AV on ZIPs.
