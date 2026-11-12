-- A134: Super Admin role (self-approves risky actions; other Admins are alerted).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
