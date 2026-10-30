-- Build Order step 9: last health-check result per environment.
ALTER TABLE "SiteEnvironment"
  ADD COLUMN "lastHealthAt" TIMESTAMP(3),
  ADD COLUMN "lastHealthOk" BOOLEAN,
  ADD COLUMN "lastHealthSummary" TEXT;
