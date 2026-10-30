-- CreateEnum
CREATE TYPE "SiteJobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "SiteInventory" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL,
    "refreshedById" TEXT,
    "wpVersion" TEXT NOT NULL,
    "phpVersion" TEXT NOT NULL,
    "wpCliVersion" TEXT NOT NULL,
    "activeTheme" TEXT,
    "maintenance" BOOLEAN,
    "safeMode" BOOLEAN NOT NULL DEFAULT false,
    "warnings" TEXT[],
    "plugins" JSONB NOT NULL,
    "themes" JSONB NOT NULL,

    CONSTRAINT "SiteInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteJob" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "SiteJobStatus" NOT NULL DEFAULT 'RUNNING',
    "exitCode" INTEGER,
    "output" TEXT NOT NULL DEFAULT '',
    "requestedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SiteJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteInventory_environmentId_key" ON "SiteInventory"("environmentId");

-- CreateIndex
CREATE INDEX "SiteJob_siteId_startedAt_idx" ON "SiteJob"("siteId", "startedAt");

-- CreateIndex
CREATE INDEX "SiteJob_environmentId_status_idx" ON "SiteJob"("environmentId", "status");

-- AddForeignKey
ALTER TABLE "SiteInventory" ADD CONSTRAINT "SiteInventory_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteJob" ADD CONSTRAINT "SiteJob_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
