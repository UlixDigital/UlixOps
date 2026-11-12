-- Phase 2 step 5 (A145): full encrypted backups on Google Drive.
ALTER TABLE "SiteEnvironment" ADD COLUMN "backupAutoEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "FullBackup" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedById" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "phase" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "driveFileId" TEXT,
    "fileName" TEXT,
    "md5" TEXT,
    "webViewLink" TEXT,
    "detail" TEXT,
    "cancelledById" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "FullBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FullBackup_environmentId_queuedAt_idx" ON "FullBackup"("environmentId", "queuedAt");
CREATE INDEX "FullBackup_status_idx" ON "FullBackup"("status");

ALTER TABLE "FullBackup" ADD CONSTRAINT "FullBackup_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
