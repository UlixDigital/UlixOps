-- Before/after visual checks (P4-3, A163).
CREATE TYPE "VisualCheckTrigger" AS ENUM ('deploy', 'update', 'core_update', 'autoupdate', 'manual');
CREATE TYPE "VisualCheckStatus" AS ENUM (
  'PENDING',
  'CAPTURING_BEFORE',
  'WAITING',
  'CAPTURING_AFTER',
  'CLEAN',
  'CHANGED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "VisualCheck" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "trigger" "VisualCheckTrigger" NOT NULL,
    "status" "VisualCheckStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL DEFAULT '',
    "maxDiffPercent" DOUBLE PRECISION NOT NULL,
    "pixelThreshold" DOUBLE PRECISION NOT NULL,
    "viewportWidth" INTEGER NOT NULL,
    "viewportHeight" INTEGER NOT NULL,
    "deploymentId" TEXT,
    "deploymentTargetId" TEXT,
    "requestedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VisualCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VisualPage" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "httpStatus" INTEGER,
    "detail" TEXT NOT NULL DEFAULT '',
    "diffPercent" DOUBLE PRECISION,
    "changed" BOOLEAN NOT NULL DEFAULT false,
    "hasBefore" BOOLEAN NOT NULL DEFAULT false,
    "hasAfter" BOOLEAN NOT NULL DEFAULT false,
    "hasDiff" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VisualPage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VisualCheck_environmentId_startedAt_idx" ON "VisualCheck"("environmentId", "startedAt");
CREATE INDEX "VisualCheck_status_startedAt_idx" ON "VisualCheck"("status", "startedAt");
CREATE INDEX "VisualPage_checkId_idx" ON "VisualPage"("checkId");

ALTER TABLE "VisualCheck" ADD CONSTRAINT "VisualCheck_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisualPage" ADD CONSTRAINT "VisualPage_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "VisualCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
