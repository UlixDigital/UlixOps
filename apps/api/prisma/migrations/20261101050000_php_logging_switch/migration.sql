-- AlterTable
ALTER TABLE "PhpErrorLog" ADD COLUMN     "debug" JSONB,
ADD COLUMN     "managed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "managedAt" TIMESTAMP(3),
ADD COLUMN     "managedById" TEXT,
ADD COLUMN     "previousDebug" JSONB;

