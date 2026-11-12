-- Optional dedicated SFTP endpoint for the site Files tab (A180).
-- WP Engine SSH gateway is slow / has no SFTP subsystem; FileZilla-style SFTP is faster.
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpHost" TEXT;
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpPort" INTEGER;
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpUser" TEXT;
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpPath" TEXT;
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpCredentialRef" TEXT;
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpHostKey" TEXT;
