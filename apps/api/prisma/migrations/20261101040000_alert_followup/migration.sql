-- Alert follow-up (agent decision A158).
-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('INFO', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'VERIFIED', 'AUTO_CLEARED');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "alertId" TEXT,
ADD COLUMN     "seenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "siteIds" TEXT[],
    "scope" TEXT,
    "actionable" BOOLEAN NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstRaisedAt" TIMESTAMP(3) NOT NULL,
    "lastRaisedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "fixAction" TEXT,
    "resolutionNote" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "subjectUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_kind_status_idx" ON "Alert"("kind", "status");

-- CreateIndex
CREATE INDEX "Alert_status_lastRaisedAt_idx" ON "Alert"("status", "lastRaisedAt");

-- CreateIndex
CREATE INDEX "Alert_firstRaisedAt_idx" ON "Alert"("firstRaisedAt");

-- CreateIndex
CREATE INDEX "AlertEvent_alertId_createdAt_idx" ON "AlertEvent"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "AlertEvent_type_createdAt_idx" ON "AlertEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AlertEvent_subjectUserId_type_idx" ON "AlertEvent"("subjectUserId", "type");

-- CreateIndex
CREATE INDEX "Notification_alertId_idx" ON "Notification"("alertId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The alert timeline is append-only, like the audit log.
REVOKE UPDATE, DELETE, TRUNCATE ON "AlertEvent" FROM ulixops_app;

CREATE FUNCTION alert_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AlertEvent is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER alert_event_append_only
  BEFORE UPDATE OR DELETE ON "AlertEvent"
  FOR EACH ROW EXECUTE FUNCTION alert_event_append_only();

-- ---- Backfill: one Alert per existing fan-out (same kind, text and timestamp) ----------------
CREATE TEMP TABLE alert_backfill AS
SELECT
  'bf' || md5(n.kind || '|' || n.title || '|' || n.body || '|' || n."createdAt"::text) AS id,
  n.kind,
  n.title,
  n.body,
  n.severity,
  ARRAY(SELECT DISTINCT unnest(min(n."siteIds")) ORDER BY 1) AS "siteIds",
  CASE WHEN n.kind = 'approval.requested' THEN min(n.meta ->> 'requestId') END AS scope,
  n.kind NOT IN ('deployment.started', 'deployment.succeeded', 'bulk_update.completed',
                 'restore.succeeded', 'uptime.up') AS actionable,
  n."createdAt" AS at,
  min(n."readAt") AS "firstSeenAt"
FROM "Notification" n
GROUP BY n.kind, n.title, n.body, n.severity, n."createdAt";

INSERT INTO "Alert" (id, kind, title, body, severity, "siteIds", scope, actionable, status,
                     "firstRaisedAt", "lastRaisedAt", "firstSeenAt")
SELECT id, kind, title, body, severity, "siteIds", scope, actionable,
       (CASE WHEN actionable THEN 'OPEN' ELSE 'INFO' END)::"AlertStatus",
       at, at, "firstSeenAt"
FROM alert_backfill;

UPDATE "Alert" SET "closedAt" = "firstRaisedAt" WHERE status = 'INFO';

UPDATE "Notification" n
SET "alertId" = 'bf' || md5(n.kind || '|' || n.title || '|' || n.body || '|' || n."createdAt"::text),
    "seenAt" = n."readAt";

INSERT INTO "AlertEvent" (id, "alertId", type, "createdAt")
SELECT replace(gen_random_uuid()::text, '-', ''), id, 'RAISED', at FROM alert_backfill;

-- Old rows only know "read"; that also counts as seen.
INSERT INTO "AlertEvent" (id, "alertId", type, "userId", "createdAt")
SELECT replace(gen_random_uuid()::text, '-', ''), n."alertId", t.type, n."userId", n."readAt"
FROM "Notification" n CROSS JOIN (VALUES ('SEEN'), ('READ')) AS t(type)
WHERE n."readAt" IS NOT NULL AND n."alertId" IS NOT NULL;

-- A site that already came back up / a restore that later succeeded: cleared on its own.
WITH cleared AS (
  SELECT a.id, min(r."firstRaisedAt") AS at
  FROM "Alert" a
  JOIN "Alert" r
    ON r."siteIds" = a."siteIds" AND r."firstRaisedAt" > a."firstRaisedAt"
   AND ((a.kind = 'uptime.down' AND r.kind = 'uptime.up')
     OR (a.kind = 'restore.failed' AND r.kind = 'restore.succeeded'))
  WHERE a.status = 'OPEN'
  GROUP BY a.id
)
UPDATE "Alert" a SET status = 'AUTO_CLEARED', "closedAt" = c.at
FROM cleared c WHERE a.id = c.id;

INSERT INTO "AlertEvent" (id, "alertId", type, note, "createdAt")
SELECT replace(gen_random_uuid()::text, '-', ''), id, 'AUTO_CLEARED',
       'Recovered before follow-up tracking started', "closedAt"
FROM "Alert" WHERE status = 'AUTO_CLEARED';

-- Approval requests that were already decided: the decider handled it.
WITH decided AS (
  SELECT a.id, r."decidedById" AS who, r."decidedAt" AS at, r.status::text AS outcome
  FROM "Alert" a JOIN "ApprovalRequest" r ON r.id = a.scope
  WHERE a.kind = 'approval.requested' AND r."decidedAt" IS NOT NULL
)
UPDATE "Alert" a
SET status = 'VERIFIED', "ownerId" = d.who, "acknowledgedAt" = d.at, "resolvedAt" = d.at,
    "resolvedById" = d.who, resolution = 'FIXED', "fixAction" = 'approval_decided',
    "resolutionNote" = 'Request ' || lower(d.outcome), "verifiedAt" = d.at, "closedAt" = d.at
FROM decided d WHERE a.id = d.id;

INSERT INTO "AlertEvent" (id, "alertId", type, "userId", "subjectUserId", note, "createdAt")
SELECT replace(gen_random_uuid()::text, '-', ''), a.id, t.type,
       CASE WHEN t.type = 'RESOLVED' THEN a."resolvedById" END,
       CASE WHEN t.type = 'CONFIRMED' THEN a."resolvedById" END,
       CASE WHEN t.type = 'RESOLVED' THEN a."resolutionNote" ELSE 'Approval request decided' END,
       a."resolvedAt"
FROM "Alert" a CROSS JOIN (VALUES ('RESOLVED'), ('CONFIRMED')) AS t(type)
WHERE a.kind = 'approval.requested' AND a.status = 'VERIFIED';

DROP TABLE alert_backfill;
