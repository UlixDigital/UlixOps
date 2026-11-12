-- A135: WordPress core updates and an honest "last checked for updates" time.
ALTER TABLE "SiteInventory"
  ADD COLUMN "coreUpdateVersion" TEXT,
  ADD COLUMN "updatesCheckedAt" TIMESTAMP(3);
