-- CreateTable
CREATE TABLE "SiteEnvironmentLock" (
    "environmentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteEnvironmentLock_pkey" PRIMARY KEY ("environmentId")
);

-- AddForeignKey
ALTER TABLE "SiteEnvironmentLock" ADD CONSTRAINT "SiteEnvironmentLock_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
