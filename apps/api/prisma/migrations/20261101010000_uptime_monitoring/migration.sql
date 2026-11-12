-- Phase 3 step 2 (A149): uptime monitoring.
ALTER TABLE "SiteEnvironment" ADD COLUMN "uptimeEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "UptimeMonitor" (
    "environmentId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "responseMs" INTEGER,
    "error" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "failingSince" TIMESTAMP(3),
    "incidentId" TEXT,

    CONSTRAINT "UptimeMonitor_pkey" PRIMARY KEY ("environmentId")
);

CREATE TABLE "UptimeCheck" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "responseMs" INTEGER,
    "error" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UptimeCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UptimeIncident" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "error" TEXT,
    "failedChecks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UptimeIncident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UptimeCheck_environmentId_checkedAt_idx" ON "UptimeCheck"("environmentId", "checkedAt");
CREATE INDEX "UptimeCheck_checkedAt_idx" ON "UptimeCheck"("checkedAt");
CREATE INDEX "UptimeIncident_environmentId_startedAt_idx" ON "UptimeIncident"("environmentId", "startedAt");
CREATE INDEX "UptimeIncident_startedAt_idx" ON "UptimeIncident"("startedAt");

ALTER TABLE "UptimeMonitor" ADD CONSTRAINT "UptimeMonitor_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UptimeCheck" ADD CONSTRAINT "UptimeCheck_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UptimeIncident" ADD CONSTRAINT "UptimeIncident_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
