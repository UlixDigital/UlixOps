-- CreateTable
CREATE TABLE "DnsZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "accountName" TEXT,
    "plan" TEXT,
    "nameServers" TEXT[],
    "originalNameServers" TEXT[],
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "checklist" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "DnsZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsSnapshot" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "takenById" TEXT,
    "records" JSONB NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,

    CONSTRAINT "DnsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsChange" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "lines" TEXT[],
    "ok" BOOLEAN NOT NULL,

    CONSTRAINT "DnsChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsRollback" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalId" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "detail" TEXT,

    CONSTRAINT "DnsRollback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DnsZone_name_key" ON "DnsZone"("name");

-- CreateIndex
CREATE INDEX "DnsSnapshot_zoneId_takenAt_idx" ON "DnsSnapshot"("zoneId", "takenAt");

-- CreateIndex
CREATE INDEX "DnsChange_zoneId_at_idx" ON "DnsChange"("zoneId", "at");

-- CreateIndex
CREATE INDEX "DnsRollback_zoneId_createdAt_idx" ON "DnsRollback"("zoneId", "createdAt");

-- AddForeignKey
ALTER TABLE "DnsSnapshot" ADD CONSTRAINT "DnsSnapshot_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DnsZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsChange" ADD CONSTRAINT "DnsChange_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DnsZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRollback" ADD CONSTRAINT "DnsRollback_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DnsZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRollback" ADD CONSTRAINT "DnsRollback_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "DnsSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

