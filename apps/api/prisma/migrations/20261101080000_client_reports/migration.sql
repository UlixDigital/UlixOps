-- Monthly client reports (P4-4, A164).
CREATE TYPE "ClientReportStatus" AS ENUM ('READY', 'FAILED');

CREATE TABLE "ClientReport" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "ClientReportStatus" NOT NULL DEFAULT 'READY',
    "summary" JSONB,
    "detail" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ClientReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientReport_clientKey_periodStart_key" ON "ClientReport"("clientKey", "periodStart");
CREATE INDEX "ClientReport_generatedAt_idx" ON "ClientReport"("generatedAt");
