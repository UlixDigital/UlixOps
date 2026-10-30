# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Prisma's migration engine links against OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ulixops/api build

# Runtime: production dependencies of the API only, owned by root and read-only for the app user.
FROM base AS runtime
ENV NODE_ENV=production CHECKPOINT_DISABLE=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod --frozen-lockfile --filter @ulixops/api
COPY apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
COPY --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
# Mount point of the plugin-store volume; a fresh volume takes this owner (agent decision A63).
RUN mkdir -p /data/plugins && chown node:node /data/plugins && chmod 0750 /data/plugins
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
