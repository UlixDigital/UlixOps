-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'DEVELOPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Host" AS ENUM ('WPENGINE', 'OTHER');

-- CreateEnum
CREATE TYPE "Conn" AS ENUM ('SSH', 'SFTP', 'FTPS', 'FTP');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('QUEUED', 'SNAPSHOT', 'STAGING', 'CHECKING', 'DEPLOYING', 'DONE', 'ROLLED_BACK', 'FAILED', 'PAUSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "host" "Host" NOT NULL,
    "connection" "Conn" NOT NULL DEFAULT 'SSH',
    "sshHost" TEXT NOT NULL,
    "sshUser" TEXT NOT NULL,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "wpPath" TEXT NOT NULL,
    "stagingUrl" TEXT,
    "credentialRef" TEXT NOT NULL,
    "tags" TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginVersion" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "changelog" TEXT NOT NULL,
    "dbChanging" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "pluginVersionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "stagingFirst" BOOLEAN NOT NULL DEFAULT true,
    "batchSize" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentTarget" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "status" "TargetStatus" NOT NULL DEFAULT 'QUEUED',
    "log" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "DeploymentTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "siteIds" TEXT[],
    "ip" TEXT,
    "result" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Site_url_key" ON "Site"("url");

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_slug_key" ON "Plugin"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PluginVersion_pluginId_version_key" ON "PluginVersion"("pluginId", "version");

-- AddForeignKey
ALTER TABLE "PluginVersion" ADD CONSTRAINT "PluginVersion_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backup" ADD CONSTRAINT "Backup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

