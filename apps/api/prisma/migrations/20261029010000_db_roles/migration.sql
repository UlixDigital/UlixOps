-- Least-privilege runtime role for the API (agent decision A32). This migration holds no secret:
-- LOGIN and the password are granted at deploy time by dist/db-roles.js from APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ulixops_app') THEN
    CREATE ROLE ulixops_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ulixops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ulixops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ulixops_app;

-- Tables that later migrations create get the same rights automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ulixops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ulixops_app;

-- The migration history belongs to the migrator only.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM ulixops_app;
  END IF;
END
$$;

-- The audit log is append-only (spec section 5): the app may read and add rows, nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM ulixops_app;

-- Second barrier: no role at all can change or remove a row through normal SQL.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
