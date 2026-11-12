-- Phase 2 step 4 (A144): file integrity checks, findings and known-safe rules.
CREATE TABLE "IntegrityCheck" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "coreChecked" BOOLEAN NOT NULL DEFAULT false,
    "pluginsChecked" BOOLEAN NOT NULL DEFAULT false,
    "verifiedPlugins" INTEGER NOT NULL DEFAULT 0,
    "unverifiable" TEXT[],
    "detail" TEXT,

    CONSTRAINT "IntegrityCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrityFinding" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "ignored" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IntegrityFinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrityIgnore" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityIgnore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrityCheck_environmentId_startedAt_idx" ON "IntegrityCheck"("environmentId", "startedAt");
CREATE INDEX "IntegrityCheck_status_idx" ON "IntegrityCheck"("status");
CREATE INDEX "IntegrityFinding_checkId_idx" ON "IntegrityFinding"("checkId");
CREATE UNIQUE INDEX "IntegrityIgnore_environmentId_scope_component_path_key" ON "IntegrityIgnore"("environmentId", "scope", "component", "path");

ALTER TABLE "IntegrityCheck" ADD CONSTRAINT "IntegrityCheck_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityFinding" ADD CONSTRAINT "IntegrityFinding_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "IntegrityCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityIgnore" ADD CONSTRAINT "IntegrityIgnore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
