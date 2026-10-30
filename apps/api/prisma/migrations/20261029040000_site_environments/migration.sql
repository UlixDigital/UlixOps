-- CreateEnum
CREATE TYPE "EnvKind" AS ENUM ('PRODUCTION', 'STAGING');

-- AlterTable
ALTER TABLE "Site" DROP COLUMN "connection",
DROP COLUMN "credentialRef",
DROP COLUMN "sshHost",
DROP COLUMN "sshPort",
DROP COLUMN "sshUser",
DROP COLUMN "stagingUrl",
DROP COLUMN "wpPath",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SiteEnvironment" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" "EnvKind" NOT NULL,
    "url" TEXT NOT NULL,
    "connection" "Conn" NOT NULL DEFAULT 'SSH',
    "sshHost" TEXT NOT NULL,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "sshUser" TEXT NOT NULL,
    "wpPath" TEXT NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "hostKey" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "wpVersion" TEXT,
    "phpVersion" TEXT,
    "wpCliVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteEnvironment_siteId_kind_key" ON "SiteEnvironment"("siteId", "kind");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_createdAt_idx" ON "ApprovalRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "SiteEnvironment" ADD CONSTRAINT "SiteEnvironment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

