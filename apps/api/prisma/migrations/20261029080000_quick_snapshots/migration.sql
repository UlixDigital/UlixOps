-- Build Order step 8: quick pre-update snapshots (expand the skeletal Backup model).
-- No existing Backup rows in production yet; ADD columns then drop the old FK restrict.

ALTER TABLE "Backup" DROP CONSTRAINT "Backup_siteId_fkey";

ALTER TABLE "Backup"
  ADD COLUMN "environmentId" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "pluginName" TEXT,
  ADD COLUMN "pluginVersion" TEXT,
  ADD COLUMN "includesDb" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "sizeBytes" INTEGER,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "restoredAt" TIMESTAMP(3);

-- Drop any leftover rows from earlier schema experiments (none expected).
DELETE FROM "Backup" WHERE "environmentId" IS NULL;

ALTER TABLE "Backup" ALTER COLUMN "environmentId" SET NOT NULL;

ALTER TABLE "Backup" ADD CONSTRAINT "Backup_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Backup" ADD CONSTRAINT "Backup_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Backup_siteId_createdAt_idx" ON "Backup"("siteId", "createdAt");
CREATE INDEX "Backup_environmentId_createdAt_idx" ON "Backup"("environmentId", "createdAt");
CREATE INDEX "Backup_expiresAt_idx" ON "Backup"("expiresAt");
CREATE INDEX "Backup_status_idx" ON "Backup"("status");
