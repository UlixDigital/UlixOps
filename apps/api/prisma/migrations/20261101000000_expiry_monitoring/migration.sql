-- Phase 3 step 1 (A148): SSL certificate and domain registration expiry.
CREATE TABLE "SslCertificate" (
    "environmentId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "https" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "issuer" TEXT,
    "subject" TEXT,
    "altNames" TEXT[],
    "error" TEXT,
    "domain" TEXT,
    "alertedDays" INTEGER,
    "alertedValidTo" TIMESTAMP(3),
    "alertedInvalid" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SslCertificate_pkey" PRIMARY KEY ("environmentId")
);

CREATE TABLE "DomainRegistration" (
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "registrar" TEXT,
    "error" TEXT,
    "manualExpiresAt" TIMESTAMP(3),
    "manualSetById" TEXT,
    "alertedDays" INTEGER,
    "alertedExpiresAt" TIMESTAMP(3),

    CONSTRAINT "DomainRegistration_pkey" PRIMARY KEY ("domain")
);

CREATE INDEX "SslCertificate_domain_idx" ON "SslCertificate"("domain");

ALTER TABLE "SslCertificate" ADD CONSTRAINT "SslCertificate_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "SiteEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
