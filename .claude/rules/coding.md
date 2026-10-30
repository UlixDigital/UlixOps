# Coding rules (spec section 9)

1. TypeScript strict everywhere. No `any` (lint error); use `unknown` + Zod at the edges.
2. Monorepo boundaries: `apps/web` (UI), `apps/api` (business logic, DB), `apps/runner` (remote ops), `packages/shared` (schemas and types shared by api and runner). Shared code goes in `packages/shared`, never copied.
3. Every remote operation sits behind a typed service function with unit tests. Inject the executor so it can be tested without SSH.
4. Required tests: command building, RBAC and approval logic (unit, Vitest); the deploy → fail → rollback path (e2e, Playwright, against the `test-wp` container).
5. Keep `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` green before finishing a step.
6. Schema changes go through Prisma migrations committed under `apps/api/prisma/migrations`. Never edit an applied migration.
7. Parse env vars with Zod at startup (`src/env.ts` per app); fail fast on missing or invalid values.
8. Build in docs/ROADMAP.md order. Finish and test one step, update ROADMAP.md, then stop and summarise.
9. Anything the spec does not specify: choose the simplest secure option and add a row to docs/DECISIONS.md under "Agent decisions".
