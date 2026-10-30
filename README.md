# UlixOps

Ulix Digital's private, security-first hub for managing its WordPress sites at server level (SSH/SFTP + WP-CLI): deploy custom plugins staging-first and in phases, with quick snapshots, health checks and automatic rollback.

- Spec (source of truth): [docs/SPEC.md](docs/SPEC.md)
- Progress: [docs/ROADMAP.md](docs/ROADMAP.md). **Current state: Build Order steps 1–5 done; step 6 (site detail: inventory, plugins & themes, emergency actions) next.**
- Architecture and the runner/API boundary: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Security requirements: [docs/SECURITY.md](docs/SECURITY.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Emergency access: [docs/BREAK-GLASS.md](docs/BREAK-GLASS.md) (summary below)

## Repository layout

| Path              | What                                                            |
| ----------------- | --------------------------------------------------------------- |
| `apps/web`        | Next.js dashboard (App Router, Tailwind, shadcn/ui tokens)      |
| `apps/api`        | Express API: auth, RBAC, business logic; owns the Prisma schema |
| `apps/runner`     | BullMQ worker: the only component allowed to reach sites        |
| `packages/shared` | Remote command allowlist, queue job schema, env parsing         |
| `docker/test-wp`  | Disposable WordPress test site with key-only SSH and WP-CLI     |
| `scripts/`        | Dev helpers                                                     |

## Requirements

- Node.js 24 LTS, with pnpm 10 through Corepack (`corepack enable`)
- Docker with Compose v2
- OpenSSH client (`ssh-keygen`)

## Local setup

```sh
corepack enable
pnpm install

cp .env.example .env
# Fill in at least POSTGRES_PASSWORD, APP_DB_PASSWORD, REDIS_PASSWORD, TEST_WP_DB_PASSWORD,
# SESSION_SECRET and TOTP_ENCRYPTION_KEY
# (generate each with: openssl rand -hex 32), then for host-run dev:
#   DATABASE_URL=postgresql://ulixops_app:<APP_DB_PASSWORD>@localhost:5432/ulixops
#   MIGRATION_DATABASE_URL=postgresql://ulixops:<POSTGRES_PASSWORD>@localhost:5432/ulixops
#   REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379

sh scripts/dev-ssh-key.sh   # dev-only SSH key for the test site, kept in .dev/ (git-ignored)

# Postgres, Redis and the test WordPress site, published on 127.0.0.1 only
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile testsite \
  up -d postgres redis test-wp test-wp-db test-wp-staging test-wp-staging-db

pnpm db:migrate             # apply Prisma migrations
pnpm dev                    # web on http://localhost:3000, api on http://localhost:4000
```

To run the whole stack in containers instead (production-like, only the web app is published):

```sh
docker compose --profile testsite up -d --build
```

On the production VPS, leave out `--profile testsite` and `docker-compose.dev.yml`. Live hub is AWS EC2 `ulixops@18.218.128.255`. Deployment to `ulixops.ulixdigital.com` (Cloudflare Tunnel + Access) is in [docs/DEPLOY.md](docs/DEPLOY.md): preferred `DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`.

### First sign-in

Create the first Admin. The command prints a one-time setup link (valid 24 hours):

```sh
# Stack running in Docker:
docker compose exec api node dist/cli.js create-admin --email you@ulixdigital.com --name "Your Name"
# Or, with pnpm dev on the host:
pnpm --filter @ulixops/api cli create-admin --email you@ulixdigital.com --name "Your Name"
```

Open the link, choose a password (at least 12 characters) and scan the QR code with an authenticator app (1Password, Google or Microsoft Authenticator). From then on, sign in at `http://localhost:3000/login` with your password and the 6-digit code, or with a passkey once you've added one under My account. Locally, use Chrome or Firefox: the session cookies are `Secure`, which those browsers allow on `http://localhost`.

### Local vault (Infisical)

The stack includes a self-hosted Infisical vault for site SSH keys (UI on `http://localhost:8081`). Set it up once, after filling in the `INFISICAL_*` passwords and keys in `.env` (see `.env.example`):

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d infisical
pnpm --filter @ulixops/runner build
node apps/runner/dist/vault-setup.js --url http://127.0.0.1:8081 --email you@ulixdigital.com \
  --env-out .env --admin-out .dev/infisical-admin.txt
```

This writes the vault admin password to `.dev/infisical-admin.txt` (mode 600, never printed) and the runner's login to `.env`. Then create SSH keys in UlixOps under **Settings → Credentials** and add sites under **Sites**. For the test site, append the new public key to `.dev/test-wp/authorized_keys` and run `docker compose restart test-wp`, then register it with SSH host `test-wp`, port 22, user `wpdev`, path `/var/www/html`, and site URL `http://localhost:8080` (health checks rewrite that to `http://test-wp/` inside the runner). The first successful Test connection pins the container's SSH host key (generated when the image is built), so a rebuilt image shows up as a changed host key until an Admin's reset is approved.

### Test WordPress site

- `http://localhost:8080`: WordPress (production fixture), installed automatically on first start.
- `http://localhost:8082`: second WordPress (`test-wp-staging`) for staging-first deploy tests; register as a site's staging env with SSH host `test-wp-staging`, port 22, user `wpdev`.
- SSH (key only): `ssh -i .dev/ssh/test_wp_ed25519 -p 2222 wpdev@127.0.0.1 wp --path=/var/www/html core version` (staging SSH on port `2223`)
- The admin user `ulixops-admin` gets a random password that is never printed. To use wp-admin, set one over SSH: `wp --path=/var/www/html user update ulixops-admin --prompt=user_pass`
- Reset the site with `docker compose --profile testsite down -v` (this also deletes the local hub database volumes).

## Commands

| Command           | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `pnpm dev`        | Run web, api and runner in watch mode                        |
| `pnpm test`       | Unit tests (Vitest) in every package                         |
| `pnpm lint`       | ESLint, including the runner/API boundary and no-`any` rules |
| `pnpm format`     | Prettier (`pnpm format:check` in CI)                         |
| `pnpm typecheck`  | TypeScript strict type-check in every package                |
| `pnpm build`      | Production builds                                            |
| `pnpm db:migrate` | Create/apply Prisma migrations (dev)                         |
| `pnpm audit:deps` | Dependency audit (fails on high or critical)                 |

There is no hosted CI. Before deploying, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm audit:deps` locally (agent decision A128).

## Environment variables

Names only. Values live in `.env` locally (git-ignored) and in Infisical in production. See `.env.example`.

| Name                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`             | PostgreSQL connection                                               |
| `REDIS_URL`                | BullMQ queue                                                        |
| `SESSION_SECRET`           | Session signing (from vault)                                        |
| `INFISICAL_CLIENT_ID`      | Vault access (runner only), written by vault-setup                  |
| `INFISICAL_CLIENT_SECRET`  | Vault access (runner only), written by vault-setup                  |
| `WPENGINE_API_USER`        | WP Engine API                                                       |
| `WPENGINE_API_PASSWORD`    | WP Engine API                                                       |
| `SMTP_URL`                 | Email notifications                                                 |
| `SLACK_WEBHOOK_URL`        | Slack notifications (optional)                                      |
| `GOOGLE_DRIVE_SA_JSON_REF` | Vault ref for Drive service account (Phase 2)                       |
| `CLOUDFLARE_API_TOKEN_REF` | Vault ref for DNS-scoped token (Phase 3)                            |
| `ALLOWED_IPS`              | IP allowlist                                                        |
| `SNAPSHOT_RETENTION_DAYS`  | Snapshot retention, default 7 (also editable in Settings)           |
| `SNAPSHOT_ENCRYPTION_KEY`  | AES-256 key for quick snapshots (runner only, 64 hex)               |
| `SNAPSHOT_STORE_DIR`       | Absolute folder for encrypted snapshots (default `/data/snapshots`) |
| `POSTGRES_PASSWORD`        | Compose: Postgres password                                          |
| `APP_DB_PASSWORD`          | Compose: password of the API's restricted database role             |
| `MIGRATION_DATABASE_URL`   | Host-run dev: owner connection for `pnpm db:migrate`                |
| `REDIS_PASSWORD`           | Compose: Redis password                                             |
| `TEST_WP_DB_PASSWORD`      | Compose: test WordPress database password                           |
| `API_URL`                  | Web → API base URL (default `http://localhost:4000`)                |
| `API_PORT`                 | API listen port (default 4000)                                      |
| `RUNNER_CONCURRENCY`       | Parallel jobs per runner (default 2)                                |
| `PLUGIN_STORE_DIR`         | Absolute folder for plugin ZIPs (default `/data/plugins`)           |
| `CLOUDFLARE_TUNNEL_TOKEN`  | Production only: Cloudflare Tunnel connector (server env file)      |

## Break-glass: if UlixOps is down

Full procedure: [docs/BREAK-GLASS.md](docs/BREAK-GLASS.md). In short:

1. **Declare it** to the team, with two people involved where possible.
2. **Open the sealed offline kit**: the emergency SSH key, its separately stored passphrase, Admin portal logins and the site access sheet.
3. **Connect directly:** `ssh -i <emergency-key> <environment>@<environment>.ssh.wpengine.net` (other hosts: details from the access sheet).
4. **Make the smallest fix:** `wp plugin deactivate <plugin-slug>`, or rename the plugin folder over SFTP; `wp maintenance-mode activate`; `wp cache flush`; restore a WP Engine backup point if needed.
5. **Log every action** by hand, then import the log into the audit log once the hub is back.
6. **Afterwards:** rotate every credential used, re-seal the kit and review the incident. Restore the hub from its encrypted daily database backup if needed.
