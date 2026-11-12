-- Restore from Google Drive (A152): safety copies and restore requests.

-- AlterTable
ALTER TABLE "FullBackup" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'WEEKLY';

-- CreateTable
CREATE TABLE "FullRestore" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalId" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "phase" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "safetyBackupId" TEXT,
    "healthOk" BOOLEAN,
    "healthSummary" TEXT,

    CONSTRAINT "FullRestore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FullRestore_environmentId_createdAt_idx" ON "FullRestore"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "FullRestore_status_idx" ON "FullRestore"("status");

-- AddForeignKey
ALTER TABLE "FullRestore" ADD CONSTRAINT "FullRestore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullRestore" ADD CONSTRAINT "FullRestore_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FullBackup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullRestore" ADD CONSTRAINT "FullRestore_safetyBackupId_fkey" FOREIGN KEY ("safetyBackupId") REFERENCES "FullBackup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
