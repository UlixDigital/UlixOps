-- Dedicated Files SFTP may use password auth (A182). Value is vault-only; this column is the mode.
ALTER TABLE "SiteEnvironment" ADD COLUMN "filesSftpAuthKind" TEXT;
