-- Phase 2 step 2 (A131): vulnerability catalogue (Wordfence Intelligence) and findings.
CREATE TABLE "Vulnerability" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "cvssScore" DOUBLE PRECISION,
    "cve" TEXT,
    "reference" TEXT,
    "publishedAt" TIMESTAMP(3),
    "software" JSONB NOT NULL,
    "softwareKeys" TEXT[],
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vulnerability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VulnerabilityFinding" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "softwareType" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "fixedIn" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "VulnerabilityFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Vulnerability_softwareKeys_idx" ON "Vulnerability" USING GIN ("softwareKeys");
CREATE UNIQUE INDEX "VulnerabilityFinding_environmentId_vulnerabilityId_software_key" ON "VulnerabilityFinding"("environmentId", "vulnerabilityId", "softwareType", "slug");
CREATE INDEX "VulnerabilityFinding_environmentId_resolvedAt_idx" ON "VulnerabilityFinding"("environmentId", "resolvedAt");
CREATE INDEX "VulnerabilityFinding_resolvedAt_idx" ON "VulnerabilityFinding"("resolvedAt");

ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability"("id") ON DELETE CASCADE ON UPDATE CASCADE;
