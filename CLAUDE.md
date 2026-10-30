# UlixOps
Secure central hub for Ulix Digital's WordPress sites. Full spec: docs/SPEC.md (source of truth).

## Stack
TypeScript (strict) monorepo: apps/web (Next.js), apps/api (Node), apps/runner (BullMQ worker), packages/shared.
PostgreSQL + Prisma, Redis + BullMQ, Tailwind + shadcn/ui, Vitest, Playwright.

Node 24 LTS, pnpm 10 workspaces. API is Express 5; Prisma schema and migrations live in apps/api/prisma.

## Non-negotiable rules
- Only apps/runner may fetch credentials or open SSH/SFTP connections.
- Remote commands come ONLY from the allowlist in packages/shared/src/commands.ts. Never interpolate raw input.
- Validate every input with Zod. No `any`.
- Never log or return secrets. Redact command output.
- Every mutating action writes an AuditLog row.
- Bulk / all-sites actions require an approved ApprovalRequest.
- Never touch real client sites in dev/tests; use the local test WordPress container.
- Follow docs/ROADMAP.md order; update it when a step is done.

Also read: .claude/rules/security.md, .claude/rules/coding.md, .claude/rules/ui.md, docs/ARCHITECTURE.md (runner/API boundary), docs/DECISIONS.md (record every "agent decision" there).

## Live hub access (production)
- **Host:** AWS EC2 `ulixops@18.218.128.255` (sole production host).
- **URL:** https://ulixops.ulixdigital.com (Cloudflare Tunnel + Access).
- **SSH key (laptop):** `~/.ssh/ulixops_deploy_ed25519` (`IdentitiesOnly=yes`).
- **SSH:** `ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255`
- **Deploy (preferred — no git):** `DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`  
  Syncs the local working tree over SSH/rsync and rebuilds on AWS. Does **not** use GitHub or `.git`.
- **Legacy git deploy:** `DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy.sh` (committed HEAD only; optional).
- **On server:** `~/ulixops` + `~/ulixops.env`; stack via `docker compose -f docker-compose.yml -f docker-compose.prod.yml` (load env from `~/ulixops.env`).
- Full steps: docs/DEPLOY.md. Agent handover: docs/HANDOVER.md. Never put private keys or `ulixops.env` in chat.

## Commands
pnpm dev | pnpm test | pnpm lint | pnpm typecheck | pnpm db:migrate

Also: pnpm format | pnpm format:check | pnpm build | pnpm audit:deps
First admin: pnpm --filter @ulixops/api cli create-admin --email <email>  (prints a one-time setup link)
API integration tests need TEST_DATABASE_URL (*_test) and TEST_REDIS_URL; the dev overlay publishes Postgres/Redis on 127.0.0.1
Infra for local dev: `scripts/dev-ssh-key.sh`, then `docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile testsite up -d postgres redis test-wp test-wp-db test-wp-staging test-wp-staging-db`
