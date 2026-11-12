# Architecture

Source: docs/SPEC.md section 4, plus the runner/API boundary below.

## Components (spec section 4)

- **Web app (Next.js):** dashboard UI only; talks to the API.
- **API service:** auth, RBAC, business logic, writes jobs to the queue. Never opens SSH connections itself.
- **Isolated runner (worker):** separate container that consumes BullMQ jobs and is the _only_ component allowed to fetch SSH credentials and connect to sites. Minimal permissions, no public ports.
- **PostgreSQL:** sites, users, deployments, snapshots, audit log.
- **Redis:** queue + rate limiting.
- **Vault:** SSH private keys and API tokens, fetched at job time with short TTL.

All services on a private Docker network; only the web app is exposed, and only through Cloudflare Zero Trust.

## Monorepo layout

| Path              | Role                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`        | Next.js App Router UI. Server-side calls to the API only; no secrets, no direct DB.                                                                                                                                                          |
| `apps/api`        | Express 5 API. Owns the Prisma schema, migrations, auth, RBAC, approvals, audit log, the plugin store (checked ZIPs in the `plugin-store` volume, A63), and snapshot metadata / retention deletes (A68).                                     |
| `apps/runner`     | BullMQ worker. The only code that may fetch site credentials or open SSH/SFTP. Writes encrypted quick snapshots to the `snapshot-store` volume (A68, A69).                                                                                   |
| `docker/scanner`  | Malware scanner sidecar: ClamAV + YARA webshell rules (A138, A140). Scans site copies the runner leaves in the `scan-work` volume and writes results back. No database, queue, vault or site access; `egress` only, for signature downloads. |
| `packages/shared` | Zod schemas shared by api and runner: the remote command allowlist and queue job shapes.                                                                                                                                                     |
| `docker/test-wp`  | Disposable WordPress test site with SSH (key only) and WP-CLI, for dev and e2e tests.                                                                                                                                                        |

## Runner / API boundary

The runner is the highest-value target in the system: it holds the keys to every site. The boundary is built so that a compromised API or web container still cannot reach a site directly.

```
 browser ──Zero Trust──▶ web ──(app net)──▶ api ──(db net)──▶ postgres
                                             │
                                        (queue net)
                                             ▼
                                           redis ◀──(queue net)── runner ──(egress)──▶ sites (SSH)
                                                                     │
                                                                     └──▶ vault (credentials, short TTL)
```

1. **One way in: the queue.** The API never imports `ssh2`, `ssh2-sftp-client` or `child_process` (enforced by ESLint `no-restricted-imports`). It requests remote work only by adding a BullMQ job to the `remote-ops` queue.
2. **Jobs carry intent, not commands.** A job (`RunnerJob` in `packages/shared/src/queue.ts`) is one of `credentials.list`, `credentials.create`, `site.test`, `site.inventory`, `remote.command`, `site.snapshot` or `site.snapshot.restore`. It names a validated SSH target (host, port, user, WordPress path, vault key name, pinned host key) and, for `remote.command`, one of the allowlisted operations in `packages/shared/src/commands.ts`. There is no free-form command, path or shell string anywhere in a job. Network-only jobs (health checks, the vulnerability feed, `monitor.expiry` certificate/RDAP reads, A148, `monitor.uptime` homepage probes, A149) also run here, because only the runner has egress; `monitor.expiry` accepts public host names only, and `monitor.uptime` follows redirects to public host names only. `monitor.uptime` travels on a second queue, `monitor-ops`, consumed by its own runner worker that accepts nothing else, so the 5-minute probes never wait behind long SSH jobs (A149). Full backups (`site.backup`, A145) and restores (`site.backup.restore`, A152) stream the site through the runner and never touch the hub's disk: a restore pipes Drive → decrypt → the SSH stdin of an allowlisted `tar` (`restore.database` / `restore.files`); these stream-only ops are refused as a plain `remote.command`. Cloudflare DNS jobs (`dns.zones`, `dns.records`, `dns.apply`, `dns.purge`, A156) are network-only, run on `monitor-ops`, and are the only place the Cloudflare token is read.
3. **The runner validates again.** The runner re-parses every job with the same Zod schema before doing anything (`apps/runner/src/jobs.ts`), then converts it to an argv array with `toArgv`. Raw job data never reaches the executor. A job that fails validation fails without touching a site, and a job older than 60 seconds is refused (A49).
4. **argv, never shell strings.** Remote commands are passed as argv arrays; each argument is validated by the allowlist (slug, version and path regexes).
5. **Credentials stay in the runner.** Only the runner holds vault access for SSH keys (self-hosted Infisical, A46). It fetches a credential by the site's `credentialRef` at job time, uses it, and drops it. New keys are generated inside the runner; only the public half leaves it (A50). The SSH connection is refused unless the server presents the pinned host key (A47). Credentials are never written to Redis, Postgres, logs or job results.
6. **No database access for the runner.** The runner has no `DATABASE_URL` and is not on the `db` network. It reports results and progress through BullMQ (job progress events and return values). The API persists them to Postgres and writes the audit log. A compromised runner therefore cannot read or alter users, approvals or the audit log.
7. **Answers, not crashes.** A changed host key is returned as `{ hostKeyMismatch: true }` (nothing ran), so the API can alert Admins; the inventory and command results are validated again by the API with the same shared schemas before they are stored (A58).
8. **Redacted output only.** Command output and failure messages are redacted before they leave the runner: private-key blocks and the credential in use are stripped and the text is capped (`apps/runner/src/redact.ts`).
9. **Request and answer.** For interactive calls (Test connection, key listing, inventory, single-site actions) the API waits for the job's result through BullMQ `QueueEvents`, with a timeout; a runner that's down shows up as "runner unavailable", never as a hang (A49).

### Docker networks (docker-compose.yml)

| Network      | Internal | Members                                  | Purpose                                                                                                                           |
| ------------ | -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `edge`       | no       | web, cloudflared (prod)                  | Dev: web published on 127.0.0.1 only. Production: no published port; `cloudflared` carries traffic from Cloudflare Access to web. |
| `app`        | yes      | web, api                                 | UI → API calls.                                                                                                                   |
| `db`         | yes      | api, postgres                            | Only the API reaches the database.                                                                                                |
| `queue`      | yes      | api, runner, redis                       | Job queue.                                                                                                                        |
| `egress`     | no       | runner, test-wp, scanner                 | Runner's outbound route to sites (WP Engine SSH Gateway in production); the scanner uses it only for ClamAV signature updates.    |
| `testsite`   | yes      | test-wp, test-wp-db                      | Test site's own database.                                                                                                         |
| `vault`      | yes      | runner, infisical                        | Only the runner reaches the vault API.                                                                                            |
| `vault-data` | yes      | infisical, infisical-db, infisical-redis | The vault's own database and cache.                                                                                               |
| `vault-ui`   | no       | infisical                                | Vault UI on `127.0.0.1:8081` only (on the VPS, through an SSH tunnel).                                                            |

### Database roles

| Role              | Used by                         | Rights                                                                                           |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ulixops` (owner) | one-shot `migrate` service only | Applies migrations, then grants `ulixops_app` its login (`dist/db-roles.js`).                    |
| `ulixops_app`     | API (and its admin CLI)         | Read/write rows; no schema changes; no `_prisma_migrations`; `AuditLog`: SELECT and INSERT only. |

A trigger on `AuditLog` refuses UPDATE and DELETE for every role, the owner included, so history can only grow.

Every hub container runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped and `no-new-privileges`.
