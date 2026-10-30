# Handover — UlixOps (Cursor → Claude)

Last updated: 2026-10-30. Read with `CLAUDE.md`, `docs/DEPLOY.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`.

## Live production

| Item                | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Provider            | **AWS EC2**                                                                              |
| SSH                 | `ulixops@18.218.128.255`                                                                 |
| Deploy key (laptop) | `~/.ssh/ulixops_deploy_ed25519` (`IdentitiesOnly=yes`)                                   |
| URL                 | https://ulixops.ulixdigital.com                                                          |
| On server           | `~/ulixops`, `~/ulixops.env`                                                             |
| Compose             | `docker compose -f docker-compose.yml -f docker-compose.prod.yml` (load `~/ulixops.env`) |
| Manual deploy       | **`DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh`** (no git)             |

**Owner preference (2026-10-30):** ship **directly to AWS**; do not depend on GitHub. Use `scripts/deploy-direct.sh`.

## How to send changes to AWS (live) — direct, no git

```sh
DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh
```

What it does:
1. Ensures `~/ulixops.env` on the server (generates missing hub secrets).
2. **rsync**s the local project over SSH (excludes `.git`, `node_modules`, `.env`, `.dev`, keys, build output).
3. Rebuilds/restarts Docker Compose on the VPS.
4. Postgres/Redis **volumes are not wiped** — sites and users stay.

Uses `~/.ssh/ulixops_deploy_ed25519`. Takes several minutes. Mid-deploy, Cloudflare may briefly show “This page couldn’t load” — reload after it finishes.

### Do / don’t

- **Do** deploy with `deploy-direct.sh` after local changes.
- **Do** keep `DEPLOY_HOST=ulixops@18.218.128.255` (AWS).
- **Don’t** require git commit/push for live.
- **Don’t** put secrets in the synced tree; server keeps `~/ulixops.env`.
- **Don’t** run a second `cloudflared` elsewhere with the live tunnel token (A126).
- Optional legacy: `scripts/deploy.sh` still exists (git archive of committed HEAD) if a `.git` tree is present.

## Repo / branch

- Remote: `git@github.com:UlixDevs/ulixops.git`, branch `main`.
- Phase 1 Build Order steps **0–12 done**; next roadmap item is **step 13** (Phase 1 acceptance / SPEC §10), then Phase 2.

## Recent product work (agent decisions)

| #         | What                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A113      | Emergency tab: inventory first; live maintenance after paint (no hang)                                                                                       |
| A114–A115 | Fast **Refresh inventory** (`checkUpdates: false`, skip plugin load) vs **Check for updates**; longer timeouts                                               |
| A116–A119 | Sites **Quick actions**: multi-select, Live/Staging, filters, select-all-shown, collapsible; runs via `POST /api/sites/quick-action` (stable across deploys) |
| A120      | Docs + `CLAUDE.md` live host = AWS EC2                                                                                                                       |
| A126–A127 | One tunnel connector only (AWS); scrub alternate-host docs/memory                                                                                            |

Key files: `apps/web/src/app/(app)/sites/site-quick-actions.tsx`, `apps/web/src/app/api/sites/quick-action/route.ts`, `apps/web/src/lib/quick-site-action.ts`, runner inventory + `apps/api/src/sites/operations.ts`.

## Standing owner prefs

- Commit + deploy when shipping fixes; push when asked (or when needed for CI green).
- Don’t force-push / wipe GitHub history.
- Never touch real client sites from dev — use local `test-wp`.
- Only `apps/runner` opens SSH; commands from allowlist only.
- Record agent choices in `docs/DECISIONS.md`.

## CI gotchas seen this week

1. `pnpm format:check` — run Prettier before push (`docs/*.md` and TS).
2. Inventory int test must expect `checkUpdates: false` on default refresh (`operations.int.test.ts`).
3. Deploy job fails at `ssh-keyscan` if AWS SG blocks GitHub — fix SG or deploy from laptop.

## Suggested next for Claude

1. Confirm CI green after SG / `DEPLOY_HOST` fix.
2. Drive **ROADMAP step 13** (Phase 1 acceptance).
3. Live QA polish on Quick actions / inventory as owner requests.
