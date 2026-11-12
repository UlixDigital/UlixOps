// Full backups to Google Drive (Phase 2 step 5, A145). Queue in Postgres, one backup at a time,
// weekly on the scheduled day: check the site is healthy → back up (runner) → keep only the new
// copy (older ones are deleted from Drive by the runner once the new one is verified).
import {
  BackupSchedule,
  DEFAULT_BACKUP_SCHEDULE,
  FullBackupJobResult,
  FullBackupProgress,
  type FullBackupView,
  inBackupWindow,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type { FullBackup, Prisma, SiteEnvironment } from "../generated/prisma/client";
import { emailsOf } from "../malware/service";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { runHealth } from "../snapshots/bulk-update-run";

export const SCHEDULE_KEY = "backup.schedule";
export const DRIVE_KEY = "backup.drive";
/** Long sites over WP Engine's SSH gateway: dump + stream + verify. */
const BACKUP_JOB_TIMEOUT_MS = 6 * 60 * 60_000;
/** A RUNNING backup older than this was cut off. */
export const STALE_BACKUP_MS = 7 * 60 * 60_000;

export interface BackupDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };
type EnvWithSite = SiteEnvironment & { site: { id: string; name: string } };
export type BackupRow = FullBackup & { environment: EnvWithSite };

export const backupInclude = {
  environment: { include: { site: { select: { id: true, name: true } } } },
} as const satisfies Prisma.FullBackupInclude;

export async function backupViews(db: Db, rows: BackupRow[]): Promise<FullBackupView[]> {
  const emails = await emailsOf(
    db,
    rows.flatMap((r) => [r.requestedById, r.cancelledById]),
  );
  return rows.map((r) => {
    const phase = FullBackupProgress.shape.phase.safeParse(r.phase);
    return {
      id: r.id,
      siteId: r.environment.site.id,
      siteName: r.environment.site.name,
      environment: r.environment.kind,
      status: r.status as FullBackupView["status"],
      queuedAt: r.queuedAt.toISOString(),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      requestedBy: r.requestedById ? (emails.get(r.requestedById) ?? null) : null,
      cancelledBy: r.cancelledById ? (emails.get(r.cancelledById) ?? null) : null,
      phase: r.status === "RUNNING" && phase.success ? phase.data : null,
      progress: Math.max(0, Math.min(100, r.progress)),
      bytes: Number(r.bytes),
      fileName: r.fileName,
      webViewLink: r.webViewLink,
      detail: r.detail,
      removedAt: r.removedAt?.toISOString() ?? null,
      purpose: r.purpose === "SAFETY" ? "SAFETY" : "WEEKLY",
      expiresAt: r.expiresAt?.toISOString() ?? null,
    };
  });
}

// ---- Settings ------------------------------------------------------------------------------

export async function readBackupSchedule(db: Db): Promise<BackupSchedule> {
  const row = await db.setting.findUnique({ where: { key: SCHEDULE_KEY } });
  const parsed = BackupSchedule.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_BACKUP_SCHEDULE;
}

export async function writeBackupSchedule(db: Db, value: BackupSchedule, userId: string) {
  const next = BackupSchedule.parse(value);
  const json = next as unknown as Prisma.InputJsonObject;
  await db.setting.upsert({
    where: { key: SCHEDULE_KEY },
    create: { key: SCHEDULE_KEY, value: json, updatedById: userId },
    update: { value: json, updatedById: userId },
  });
  return next;
}

/** The hub's record of the Drive connection (the token itself is only in the vault). */
export async function readDriveRecord(
  db: Db,
): Promise<{ email: string | null; connectedAt: string } | null> {
  const row = await db.setting.findUnique({ where: { key: DRIVE_KEY } });
  const v = row?.value as { email?: unknown; connectedAt?: unknown } | undefined;
  return v && typeof v.connectedAt === "string"
    ? { email: typeof v.email === "string" ? v.email : null, connectedAt: v.connectedAt }
    : null;
}

export async function writeDriveRecord(db: Db, email: string | null, at: Date, userId: string) {
  const value = { email, connectedAt: at.toISOString() };
  await db.setting.upsert({
    where: { key: DRIVE_KEY },
    create: { key: DRIVE_KEY, value, updatedById: userId },
    update: { value, updatedById: userId },
  });
}

/** Environments the weekly schedule covers. */
export function backupWhere(schedule: BackupSchedule): Prisma.SiteEnvironmentWhereInput {
  return {
    backupAutoEnabled: true,
    hostKey: { not: null },
    site: { archived: false },
    kind: schedule.includeStaging ? { in: ["PRODUCTION", "STAGING"] } : "PRODUCTION",
  };
}

/** Start of the backup window `at` falls in (call only when inBackupWindow). */
export function windowStart(s: BackupSchedule, at: Date): Date {
  const start = new Date(at);
  start.setUTCHours(s.startHourUtc, 0, 0, 0);
  if (start.getTime() > at.getTime() || start.getUTCDay() !== s.dayOfWeek)
    start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

// ---- Queue and dispatch --------------------------------------------------------------------

export async function expireStaleBackups(db: Db, at: Date, all = false): Promise<number> {
  const { count } = await db.fullBackup.updateMany({
    where: {
      status: "RUNNING",
      ...(all ? {} : { startedAt: { lt: new Date(at.getTime() - STALE_BACKUP_MS) } }),
    },
    data: {
      status: "FAILED",
      finishedAt: at,
      phase: null,
      detail:
        "Interrupted: the hub restarted while this backup was running. The previous copy was kept.",
    },
  });
  return count;
}

export type EnqueueOutcome =
  | { ok: true; backupId: string; position: number }
  | { ok: false; error: "backup_pending" | "connection_untested" | "drive_not_connected" };

export async function enqueueFullBackup(
  deps: BackupDeps,
  env: EnvWithSite,
  actor: Actor,
): Promise<EnqueueOutcome> {
  const { db, now } = deps;
  if (!env.hostKey) return { ok: false, error: "connection_untested" };
  if (!(await readDriveRecord(db))) return { ok: false, error: "drive_not_connected" };
  await expireStaleBackups(db, now());
  if (
    (await db.fullBackup.count({
      where: { environmentId: env.id, status: { in: ["QUEUED", "RUNNING"] } },
    })) > 0
  )
    return { ok: false, error: "backup_pending" };
  const at = now();
  const row = await db.fullBackup.create({
    data: {
      environmentId: env.id,
      status: "QUEUED",
      purpose: "WEEKLY",
      requestedById: actor.userId,
      queuedAt: at,
      startedAt: at,
    },
  });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.backup.queue",
      result: "pending",
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: { kind: env.kind, backupId: row.id, scheduled: actor.userId === null },
    },
    at,
  );
  const position = await db.fullBackup.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
  if (actor.userId !== null) void dispatchFullBackups(deps);
  return { ok: true, backupId: row.id, position };
}

/** The covered environment not yet backed up in the current window, if any. */
export async function nextDueBackupEnv(db: Db, at: Date, schedule: BackupSchedule) {
  if (!inBackupWindow(schedule, at)) return null;
  const since = windowStart(schedule, at);
  const envs = await db.siteEnvironment.findMany({
    where: {
      ...backupWhere(schedule),
      // Once per window: any finished attempt (even skipped or failed) counts, so a broken site
      // isn't retried all night; a person can still click Back up now.
      fullBackups: {
        none: {
          purpose: "WEEKLY",
          OR: [
            { status: { in: ["QUEUED", "RUNNING"] } },
            { status: { in: ["READY", "FAILED", "SKIPPED", "REMOVED"] }, queuedAt: { gte: since } },
          ],
        },
      },
    },
    include: { site: { select: { id: true, name: true } } },
    orderBy: [{ site: { name: "asc" } }, { kind: "asc" }],
  });
  return envs[0] ?? null;
}

let dispatching: Promise<void> = Promise.resolve();

export function dispatchFullBackups(deps: BackupDeps): Promise<void> {
  dispatching = dispatching
    .then(() => dispatchOnce(deps))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "backup_dispatch_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  return dispatching;
}

async function dispatchOnce(deps: BackupDeps): Promise<void> {
  const { db, now } = deps;
  const at = now();
  await expireStaleBackups(db, at);
  if ((await db.fullBackup.count({ where: { status: "RUNNING" } })) > 0) return;
  // A malware scan or a restore holds a runner slot for a long time too; keep one free for people.
  if ((await db.malwareScan.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.fullRestore.count({ where: { status: "RUNNING" } })) > 0) return;

  let next = await db.fullBackup.findFirst({
    where: { status: "QUEUED" },
    orderBy: { queuedAt: "asc" },
  });
  if (!next) {
    const schedule = await readBackupSchedule(db);
    if (!schedule.enabled || !(await readDriveRecord(db))) return;
    const env = await nextDueBackupEnv(db, at, schedule);
    if (!env) return;
    const queued = await enqueueFullBackup(deps, env, { userId: null, ip: null });
    if (!queued.ok) return;
    next = await db.fullBackup.findUnique({ where: { id: queued.backupId } });
    if (!next) return;
  }
  const env = await db.siteEnvironment.findUnique({
    where: { id: next.environmentId },
    include: { site: { select: { id: true, name: true, archived: true } } },
  });
  if (!env?.hostKey || env.site.archived) {
    await db.fullBackup.updateMany({
      where: { id: next.id, status: "QUEUED" },
      data: {
        status: "FAILED",
        finishedAt: at,
        detail: env?.site.archived
          ? "The site was archived before the backup started."
          : "The site's connection isn't tested (no pinned host key).",
      },
    });
    return dispatchOnce(deps);
  }
  const claimed = await db.fullBackup.updateMany({
    where: { id: next.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: at, phase: null, progress: 0, bytes: 0n },
  });
  if (claimed.count !== 1) return;
  const actor = { userId: next.requestedById, ip: null };
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.backup.start",
      result: "pending",
      ip: null,
      siteIds: [env.site.id],
      meta: { kind: env.kind, backupId: next.id, scheduled: actor.userId === null },
    },
    at,
  );
  const backupId = next.id;
  const pinned = { ...env, hostKey: env.hostKey };
  void runBackup(deps, pinned, backupId, actor)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "backup_crashed",
          backupId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => void dispatchFullBackups(deps));
}

export const backupSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "site";

async function runBackup(
  deps: BackupDeps,
  env: EnvWithSite & { hostKey: string },
  backupId: string,
  actor: Actor,
): Promise<void> {
  const { db, now } = deps;
  const where = { id: backupId, status: "RUNNING" };
  const label = `${env.site.name} (${env.kind.toLowerCase()})`;
  const end = async (
    status: "FAILED" | "SKIPPED",
    detail: string,
    alert: "backup.failed" | "backup.skipped",
  ) => {
    const { count } = await db.fullBackup.updateMany({
      where,
      data: { status, finishedAt: now(), phase: null, detail: detail.slice(0, 2000) },
    });
    if (count === 0) return;
    await audit(
      db,
      {
        userId: actor.userId,
        action: "site.backup.result",
        result: status === "FAILED" ? "failure" : "skipped",
        ip: actor.ip,
        siteIds: [env.site.id],
        meta: { kind: env.kind, backupId, detail: detail.slice(0, 300) },
      },
      now(),
    );
    await deps.notifier.notify?.({
      kind: alert,
      title:
        status === "SKIPPED" ? `Backup skipped: ${label} isn't healthy` : `Backup failed: ${label}`,
      body: `${detail} The previous backup on Google Drive was kept.`,
      severity: status === "SKIPPED" ? "critical" : "warning",
      siteIds: [env.site.id],
      scope: env.id,
    });
  };

  // 1. The site must be working: never replace a good backup with one of a broken site.
  await db.fullBackup.updateMany({ where, data: { phase: "database", progress: 1 } });
  let health: { ok: boolean; summary: string };
  try {
    health = await runHealth(deps, env);
    // Keep the site's health current, so Full backups can set unhealthy sites aside (A147).
    await db.siteEnvironment.update({
      where: { id: env.id },
      data: {
        lastHealthAt: now(),
        lastHealthOk: health.ok,
        lastHealthSummary: health.summary.slice(0, 500),
      },
    });
  } catch {
    health = { ok: false, summary: "the health check couldn't run" };
  }
  if (!health.ok)
    return end(
      "SKIPPED",
      `The site failed its health check (${health.summary}).`,
      "backup.skipped",
    );

  // 2. Older copies to delete once the new one is verified; size estimate from the last one.
  // Safety copies (A152) are not replaced: they expire on their own.
  const current = await db.fullBackup.findMany({
    where: {
      environmentId: env.id,
      status: "READY",
      purpose: "WEEKLY",
      driveFileId: { not: null },
    },
    orderBy: { queuedAt: "desc" },
  });
  const expected = current[0] ? Number(current[0].bytes) : undefined;

  let write: Promise<unknown> = Promise.resolve();
  const onProgress = (data: unknown) => {
    const p = FullBackupProgress.safeParse(data);
    if (!p.success) return;
    write = write
      .then(() =>
        db.fullBackup.updateMany({
          where,
          data: { phase: p.data.phase, progress: p.data.percent, bytes: BigInt(p.data.bytes) },
        }),
      )
      .catch(() => undefined);
  };

  let raw: unknown;
  try {
    raw = await deps.runner.run(
      {
        type: "site.backup",
        backupId,
        target: {
          host: env.sshHost,
          port: env.sshPort,
          user: env.sshUser,
          wpPath: env.wpPath,
          credentialRef: env.credentialRef,
          hostKey: env.hostKey,
        },
        folderKey: env.id,
        folderName: label.slice(0, 120),
        fileStem: `${backupSlug(env.site.name)}-${env.kind.toLowerCase()}`,
        ...(expected && expected > 0 ? { expectedBytes: expected } : {}),
        oldFileIds: current.flatMap((b) => (b.driveFileId ? [b.driveFileId] : [])).slice(0, 50),
      },
      BACKUP_JOB_TIMEOUT_MS,
      { onProgress },
    );
  } catch (error) {
    await write;
    if (error instanceof RunnerUnavailableError)
      return end("FAILED", "The runner did not answer in time.", "backup.failed");
    if (error instanceof RunnerJobFailedError) return end("FAILED", error.message, "backup.failed");
    throw error;
  }
  await write;
  const parsed = FullBackupJobResult.safeParse(raw);
  if (!parsed.success)
    return end("FAILED", "The runner returned an unexpected answer.", "backup.failed");
  const result = parsed.data;
  if (result.hostKeyMismatch)
    return end(
      "FAILED",
      "Refused: the server's SSH host key no longer matches the pinned one.",
      "backup.failed",
    );
  if (result.cancelled) {
    await db.fullBackup.updateMany({
      where,
      data: { status: "CANCELLED", finishedAt: now(), phase: null, detail: "Stopped on request." },
    });
    return;
  }
  if (!result.ok || !result.driveFileId) return end("FAILED", result.detail, "backup.failed");

  const at = now();
  const stored = await db.$transaction(async (tx) => {
    const done = await tx.fullBackup.updateMany({
      where,
      data: {
        status: "READY",
        finishedAt: at,
        phase: null,
        progress: 100,
        bytes: BigInt(result.sizeBytes),
        driveFileId: result.driveFileId,
        fileName: result.fileName,
        md5: result.md5,
        webViewLink: result.webViewLink,
        detail: result.detail,
      },
    });
    if (done.count !== 1) return false;
    if (result.removed.length)
      await tx.fullBackup.updateMany({
        where: {
          environmentId: env.id,
          driveFileId: { in: result.removed },
          id: { not: backupId },
        },
        data: { status: "REMOVED", removedAt: at },
      });
    return true;
  });
  if (!stored) {
    // Stopped after the upload finished: the new file is on Drive but not recorded; it's left
    // for the owner (rare) and the old copies were already removed by the runner only if verified.
    return;
  }
  for (const kind of ["backup.failed", "backup.skipped"] as const)
    await deps.notifier.observe?.({
      kind,
      siteIds: [env.site.id],
      scope: env.id,
      ok: true,
      note: "A later backup finished and was verified",
    });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.backup.result",
      result: "success",
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: {
        kind: env.kind,
        backupId,
        bytes: result.sizeBytes,
        removed: result.removed.length,
        removeFailed: result.removeFailed.length,
      },
    },
    at,
  );
}

// ---- Stop ----------------------------------------------------------------------------------

export async function cancelFullBackup(
  deps: BackupDeps,
  backupId: string,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "backup_finished" }> {
  const { db, now } = deps;
  const row = await db.fullBackup.findUnique({
    where: { id: backupId },
    include: { environment: { select: { kind: true, siteId: true } } },
  });
  // A safety copy belongs to its restore (A152): it can't be stopped on its own.
  if (!row || row.purpose !== "WEEKLY") return { ok: false, error: "not_found" };
  const wasRunning = row.status === "RUNNING";
  const stopped = await db.fullBackup.updateMany({
    where: { id: backupId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      finishedAt: now(),
      phase: null,
      cancelledById: actor.userId,
      detail: wasRunning
        ? "Stopped while it was running. The previous copy was kept."
        : "Removed from the queue before it started.",
    },
  });
  if (stopped.count !== 1) return { ok: false, error: "backup_finished" };
  if (wasRunning)
    await deps.runner.run({ type: "site.backup.cancel", backupId }, 15_000).catch(() => undefined);
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.backup.cancel",
      result: "success",
      ip: actor.ip,
      siteIds: [row.environment.siteId],
      meta: { kind: row.environment.kind, backupId, wasRunning },
    },
    now(),
  );
  void dispatchFullBackups(deps);
  return { ok: true };
}
