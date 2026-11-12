-- Per-site monthly reports (A165). Replaces the tag-based ClientReport (A164).
DROP TABLE IF EXISTS "ClientReport";
DROP TYPE IF EXISTS "ClientReportStatus";

CREATE TYPE "SiteReportStatus" AS ENUM ('READY', 'FAILED');

CREATE TABLE "SiteReport" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "SiteReportStatus" NOT NULL DEFAULT 'READY',
    "summary" JSONB,
    "detail" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SiteReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteReport_siteId_periodStart_key" ON "SiteReport"("siteId", "periodStart");
CREATE INDEX "SiteReport_generatedAt_idx" ON "SiteReport"("generatedAt");
CREATE INDEX "SiteReport_siteId_idx" ON "SiteReport"("siteId");

ALTER TABLE "SiteReport" ADD CONSTRAINT "SiteReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
