import {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  MAX_SNAPSHOT_RETENTION_DAYS,
  MIN_SNAPSHOT_RETENTION_DAYS,
  SITE_JOB_STALE_MS,
  SnapshotRetentionSetting,
} from "@ulixops/shared";
import type { Db } from "../db";
import type { SnapshotStore } from "./store";

export const RETENTION_KEY = "snapshot.retentionDays";

export async function readRetentionDays(db: Db, fallback: number): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: RETENTION_KEY } });
  const parsed = SnapshotRetentionSetting.safeParse(row?.value);
  if (parsed.success) return parsed.data.days;
  return clamp(fallback);
}

export async function writeRetentionDays(db: Db, days: number, userId: string): Promise<number> {
  const next = SnapshotRetentionSetting.parse({ days: clamp(days) });
  await db.setting.upsert({
    where: { key: RETENTION_KEY },
    create: { key: RETENTION_KEY, value: next, updatedById: userId },
    update: { value: next, updatedById: userId },
  });
  return next.days;
}

function clamp(days: number): number {
  return Math.min(
    MAX_SNAPSHOT_RETENTION_DAYS,
    Math.max(MIN_SNAPSHOT_RETENTION_DAYS, Math.trunc(days) || DEFAULT_SNAPSHOT_RETENTION_DAYS),
  );
}

/**
 * Marks expired READY snapshots as EXPIRED and deletes their files when nothing else still
 * references that location (shared content-addressed blobs, A103). Also marks stale PENDING
 * rows as FAILED and removes orphaned blobs. Safe to call often (list/create).
 */
export async function purgeExpired(
  db: Db,
  store: SnapshotStore,
  now: Date,
): Promise<{ expired: number; failedPending: number }> {
  const due = await db.backup.findMany({
    where: {
      status: "READY",
      expiresAt: { lte: now },
    },
    select: { id: true, location: true },
    take: 200,
  });
  for (const row of due) {
    await db.backup.update({
      where: { id: row.id },
      data: { status: "EXPIRED" },
    });
    await removeIfUnreferenced(db, store, row.location);
  }

  const staleCutoff = new Date(now.getTime() - SITE_JOB_STALE_MS);
  const stale = await db.backup.findMany({
    where: { status: "PENDING", createdAt: { lt: staleCutoff } },
    select: { id: true, location: true },
    take: 200,
  });
  for (const row of stale) {
    await db.backup.update({
      where: { id: row.id },
      data: { status: "FAILED" },
    });
    await removeIfUnreferenced(db, store, row.location);
  }

  return { expired: due.length, failedPending: stale.length };
}

async function removeIfUnreferenced(db: Db, store: SnapshotStore, location: string): Promise<void> {
  if (!location || location === "pending") return;
  const stillUsed = await db.backup.count({
    where: {
      location,
      status: { in: ["READY", "PENDING"] },
    },
  });
  if (stillUsed > 0) return;
  await store.remove(location).catch(() => undefined);
}

export { DEFAULT_SNAPSHOT_RETENTION_DAYS };
