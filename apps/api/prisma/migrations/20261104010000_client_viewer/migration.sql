-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'CLIENT_VIEWER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "viewTag" TEXT;
