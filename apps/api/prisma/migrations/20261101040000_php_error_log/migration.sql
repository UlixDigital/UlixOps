-- CreateTable
CREATE TABLE "PhpErrorLog" (
    "environmentId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT,
    "fileFound" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "modifiedAt" TIMESTAMP(3),
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "groups" JSONB NOT NULL DEFAULT '[]',
    "fatal24h" INTEGER NOT NULL DEFAULT 0,
    "errors24h" INTEGER NOT NULL DEFAULT 0,
    "warnings24h" INTEGER NOT NULL DEFAULT 0,
    "lastFatalAt" TIMESTAMP(3),

    CONSTRAINT "PhpErrorLog_pkey" PRIMARY KEY ("environmentId")
);

-- AddForeignKey
ALTER TABLE "PhpErrorLog" ADD CONSTRAINT "PhpErrorLog_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

