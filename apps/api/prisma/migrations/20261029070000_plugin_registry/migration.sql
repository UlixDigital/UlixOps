-- PluginVersion gets a required sizeBytes without a default. Safe: no code wrote PluginVersion
-- rows before this step (the upload path arrives with it), so the table is empty everywhere.
-- AlterTable
ALTER TABLE "Plugin" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PluginVersion" ADD COLUMN     "requiresPhp" TEXT,
ADD COLUMN     "requiresWp" TEXT,
ADD COLUMN     "sizeBytes" INTEGER NOT NULL,
ADD COLUMN     "uploadedById" TEXT;

-- CreateTable
CREATE TABLE "PluginUpload" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "requiresWp" TEXT,
    "requiresPhp" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PluginUpload_expiresAt_idx" ON "PluginUpload"("expiresAt");
