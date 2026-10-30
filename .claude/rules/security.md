# Security rules (from docs/SECURITY.md, spec section 5)

Hard rules. If one blocks you, stop and ask; never weaken it to make something work.

1. Only `apps/runner` fetches credentials or opens SSH/SFTP. `ssh2`, `ssh2-sftp-client` and `child_process` are lint errors anywhere else, and `child_process` is a lint error in the runner too.
2. Remote commands come only from `packages/shared/src/commands.ts`: an allowlisted `op`, each argument validated by a strict regex, returned as an argv array. Never build a shell string, never interpolate user input.
3. Validate every external input with Zod: HTTP bodies, query strings, params, env vars, queue jobs (again inside the runner) and uploaded files.
4. Database access only through Prisma; no `$queryRawUnsafe` / `$executeRawUnsafe`.
5. Secrets never appear in code, commits, logs, job data, job results, API responses or the frontend. Store a vault reference (`credentialRef`), never the secret. Redact command output before it leaves the runner.
6. SSH key auth only. Plain FTP is last resort: Admin-only to enable, flagged "insecure connection" in the UI.
7. Every mutating action writes an `AuditLog` row (who, what, sites, when, IP, result). Never update or delete audit rows.
8. Bulk, all-sites, site deletion and credential changes need an approved `ApprovalRequest` decided by a different Admin than the requester.
9. Cookies: `Secure`, `HttpOnly`, `SameSite=Strict`. Sessions: 30 min idle, 12 h absolute. 2FA mandatory for every user.
10. Keep the CSP strict (nonce scripts, no `unsafe-inline` scripts, `frame-ancestors 'none'`) and security headers on every response.
11. Containers: non-root, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, only the networks they need. Only `web` publishes a port.
12. New dependencies: prefer none; otherwise well-maintained, pinned by the lockfile, and `pnpm audit:deps` must stay clean.
13. Never touch a real client site from dev or tests. Use the `test-wp` container, or the designated test site after asking.
