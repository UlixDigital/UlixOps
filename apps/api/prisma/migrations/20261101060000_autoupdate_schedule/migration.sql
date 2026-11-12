-- CreateTable
CREATE TABLE "AutoUpdateSchedule" (
    "siteId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dayOfWeek" INTEGER NOT NULL DEFAULT 2,
    "hourUtc" INTEGER NOT NULL DEFAULT 6,
    "skip" JSONB NOT NULL DEFAULT '[]',
    "holds" JSONB NOT NULL DEFAULT '[]',
    "enabledAt" TIMESTAMP(3),
    "lastWindowAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "AutoUpdateSchedule_pkey" PRIMARY KEY ("siteId")
);

-- CreateTable
CREATE TABLE "AutoUpdateRun" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "windowAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "report" JSONB NOT NULL DEFAULT '{}',
    "updated" INTEGER NOT NULL DEFAULT 0,
    "problems" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutoUpdateRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoUpdateRun_siteId_startedAt_idx" ON "AutoUpdateRun"("siteId", "startedAt");

-- AddForeignKey
ALTER TABLE "AutoUpdateSchedule" ADD CONSTRAINT "AutoUpdateSchedule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoUpdateRun" ADD CONSTRAINT "AutoUpdateRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
