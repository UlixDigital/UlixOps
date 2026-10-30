-- Build Order step 10: expand Deployment / DeploymentTarget for the deploy wizard.
DELETE FROM "DeploymentTarget";
DELETE FROM "Deployment";

ALTER TABLE "DeploymentTarget" DROP CONSTRAINT IF EXISTS "DeploymentTarget_deploymentId_fkey";
ALTER TABLE "DeploymentTarget" DROP CONSTRAINT IF EXISTS "DeploymentTarget_siteId_fkey";
ALTER TABLE "DeploymentTarget" DROP CONSTRAINT IF EXISTS "DeploymentTarget_environmentId_fkey";
ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_pluginVersionId_fkey";

DROP TABLE IF EXISTS "DeploymentTarget";
DROP TABLE IF EXISTS "Deployment";

CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "pluginVersionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvalId" TEXT,
    "stagingFirst" BOOLEAN NOT NULL DEFAULT true,
    "batchSize" INTEGER NOT NULL DEFAULT 2,
    "pauseOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeploymentTarget" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "kind" "EnvKind" NOT NULL,
    "status" "TargetStatus" NOT NULL DEFAULT 'QUEUED',
    "log" TEXT NOT NULL DEFAULT '',
    "backupId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DeploymentTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Deployment_createdAt_idx" ON "Deployment"("createdAt");
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");
CREATE INDEX "DeploymentTarget_deploymentId_status_idx" ON "DeploymentTarget"("deploymentId", "status");
CREATE INDEX "DeploymentTarget_siteId_idx" ON "DeploymentTarget"("siteId");

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_pluginVersionId_fkey" FOREIGN KEY ("pluginVersionId") REFERENCES "PluginVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
