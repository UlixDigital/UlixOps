# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ulixops/runner build

# Runtime: production dependencies of the runner only, owned by root and read-only for the app user.
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod --frozen-lockfile --filter @ulixops/runner
COPY --from=build /repo/apps/runner/dist apps/runner/dist
# Shared with the scanner sidecar (A138); created here so the volume starts owned by node.
RUN mkdir -p /scan-work && chown node:node /scan-work
WORKDIR /repo/apps/runner
USER node
CMD ["node", "dist/index.js"]
