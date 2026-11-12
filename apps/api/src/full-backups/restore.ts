// Restore from Google Drive (A152): asked for with the site's name typed to confirm → a second
// Admin approves (a Super Admin self-approves, A134) → queued → run one at a time, never beside
// a backup or malware scan. The site is locked meanwhile; the runner takes a safety copy first
// (kept SAFETY_COPY_DAYS, then deleted from Drive), restores, and the API health-checks the site.
import {
  SiteAddress,
  RestoreJobResult,
  RestoreProgress,
  type RestoreScope,
  type RestoreView,
  type RoleName,
  SAFETY_COPY_DAYS,
  type StartRestoreRequest,
  DriveDeleteResult,
  FullBackupStatus,
  RestoreStatus,
} from "@ulixops/shared";
import { randomUUID } from "node:crypto";
import { requestApproval, selfApproveIfAllowed, type ApprovalsDeps } from "../approvals/routes";
import { audit } from "../audit";
import type { Db } from "../db";
import {
  type FullBackup,
  type FullRestore,
  Prisma,
  type SiteEnvironment,
} from "../generated/prisma/client";
import { emailsOf } from "../malware/service";
import { RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { runHealth } from "../snapshots/bulk-update-run";
import { type BackupDeps, backupSlug, readDriveRecord } from "./service";

/** Safety copy + streaming the backup back + the database import, on a slow host. */
const RESTORE_JOB_TIMEOUT_MS = 10 * 60 * 60_000;
/** A RUNNING restore older than this was cut off. */
export const STALE_RESTORE_MS = 11 * 60 * 60_000;
/** Keeps the site lock fresh while the restore runs (locks go stale after SITE_JOB_STALE_MS). */
const LOCK_BEAT_MS = 60_000;
const DAY_MS = 86_400_000;

const OPEN = ["PENDING_APPROVAL", "QUEUED", "RUNNING"];

export const restoreInclude = {
  environment: { include: { site: { select: { id: true, name: true } } } },
  source: { include: { environment: { select: { kind: true, url: true } } } },
  safetyBackup: true,
} as const satisfies Prisma.FullRestoreInclude;

export type RestoreRow = FullRestore & {
  environment: { kind: "PRODUCTION" | "STAGING"; site: { id: string; name: string } };
  source: FullBackup & { environment: { kind: "PRODUCTION" | "STAGING"; url: string } };
  safetyBackup: FullBackup | null;
};

/** "https://www.shop.com/axiom/" → "www.shop.com/axiom", for search-replace (A157). */
export function siteAddress(url: string): string | null {
  try {
    const u = new URL(url);
    const value = `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
    return SiteAddress.safeParse(value).success ? value : null;
  } catch {
    return null;
  }
}

const backupAt = (b: FullBackup) => b.finishedAt ?? b.startedAt;

export async function restoreViews(db: Db, rows: RestoreRow[]): Promise<RestoreView[]> {
  const emails = await emailsOf(
    db,
    rows.flatMap((r) => [r.requestedById, r.approvedById]),
  );
  return rows.map((r) => {
    const phase = RestoreProgress.shape.phase.safeParse(r.phase);
    return {
      id: r.id,
      siteId: r.environment.site.id,
      siteName: r.environment.site.name,
      environment: r.environment.kind,
      sourceEnvironment: r.source.environment.kind,
      status: RestoreStatus.parse(r.status),
      scope: r.scope as RestoreScope,
      source: {
        backupId: r.source.id,
        purpose: r.source.purpose === "SAFETY" ? "SAFETY" : "WEEKLY",
        at: backupAt(r.source).toISOString(),
        fileName: r.source.fileName,
      },
      requestedBy: emails.get(r.requestedById) ?? null,
      approvedBy: r.approvedById ? (emails.get(r.approvedById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      phase: r.status === "RUNNING" && phase.success ? phase.data : null,
      progress: Math.max(0, Math.min(100, r.progress)),
      detail: r.detail,
      safety: r.safetyBackup
        ? {
            backupId: r.safetyBackup.id,
            status: FullBackupStatus.parse(r.safetyBackup.status),
            webViewLink: r.safetyBackup.webViewLink,
            expiresAt: r.safetyBackup.expiresAt?.toISOString() ?? null,
          }
        : null,
      health: r.healthOk === null ? null : { ok: r.healthOk, summary: r.healthSummary ?? null },
    };
  });
}

// ---- Asking --------------------------------------------------------------------------------

export type RestoreRequestError =
  | "not_found"
  | "backup_not_ready"
  | "confirm_mismatch"
  | "site_archived"
  | "connection_untested"
  | "drive_not_connected"
  | "restore_pending"
  | "site_address_invalid";

/** Hooks the approvals flow uses to start or close a restore. */
export function restoreApprovalDeps(deps: BackupDeps): ApprovalsDeps {
  return {
    db: deps.db,
    now: deps.now,
    notifier: deps.notifier,
    onRestoreDecided: (decision, restoreId, decidedById) =>
      onRestoreDecided(deps, decision, restoreId, decidedById),
  };
}

export async function requestRestore(
  deps: BackupDeps,
  input: StartRestoreRequest,
  user: { id: string; role: RoleName },
  ip: string | null,
): Promise<
  | { ok: true; restoreId: string; selfApproved: boolean }
  | { ok: false; error: RestoreRequestError | "already_pending" }
> {
  const { db, now } = deps;
  const source = await db.fullBackup.findUnique({
    where: { id: input.backupId },
    include: { environment: { include: { site: true } } },
  });
  if (!source) return { ok: false, error: "not_found" };
  // The environment to overwrite: the backup's own, or the same site's other one (A157).
  const targetKind = input.target ?? source.environment.kind;
  const env =
    targetKind === source.environment.kind
      ? source.environment
      : await db.siteEnvironment.findUnique({
          where: { siteId_kind: { siteId: source.environment.siteId, kind: targetKind } },
          include: { site: true },
        });
  if (!env) return { ok: false, error: "not_found" };
  const across = env.id !== source.environmentId;
  if (across && (!siteAddress(source.environment.url) || !siteAddress(env.url)))
    return { ok: false, error: "site_address_invalid" };
  if (source.status !== "READY" || !source.driveFileId)
    return { ok: false, error: "backup_not_ready" };
  if (input.confirmName.trim().toLowerCase() !== env.site.name.trim().toLowerCase())
    return { ok: false, error: "confirm_mismatch" };
  if (env.site.archived) return { ok: false, error: "site_archived" };
  if (!env.hostKey) return { ok: false, error: "connection_untested" };
  if (!(await readDriveRecord(db))) return { ok: false, error: "drive_not_connected" };
  if ((await db.fullRestore.count({ where: { environmentId: env.id, status: { in: OPEN } } })) > 0)
    return { ok: false, error: "restore_pending" };

  const at = now();
  const row = await db.fullRestore.create({
    data: {
      environmentId: env.id,
      sourceId: source.id,
      scope: input.scope,
      status: "PENDING_APPROVAL",
      requestedById: user.id,
      createdAt: at,
    },
  });
  const asked = await requestApproval(
    db,
    {
      action: "site.backup.restore",
      payload: {
        siteId: env.site.id,
        kind: env.kind,
        restoreId: row.id,
        backupId: source.id,
        backupAt: backupAt(source).toISOString(),
        scope: input.scope,
        ...(across ? { from: source.environment.kind } : {}),
      },
      requestedById: user.id,
      ip,
      requesterRole: user.role,
    },
    at,
    deps.notifier,
  );
  if (!asked.ok) {
    // Nothing was asked or changed: the row never stood for anything.
    await db.fullRestore.delete({ where: { id: row.id } });
    return { ok: false, error: asked.error };
  }
  await db.fullRestore.update({ where: { id: row.id }, data: { approvalId: asked.id } });
  await audit(
    db,
    {
      userId: user.id,
      action: "site.backup.restore.request",
      result: "pending",
      ip,
      siteIds: [env.site.id],
      meta: {
        kind: env.kind,
        restoreId: row.id,
        backupId: source.id,
        scope: input.scope,
        requestId: asked.id,
        from: source.environment.kind,
      },
    },
    at,
  );
  const selfApproved = await selfApproveIfAllowed(restoreApprovalDeps(deps), asked.id, user, ip);
  return { ok: true, restoreId: row.id, selfApproved };
}

export async function onRestoreDecided(
  deps: BackupDeps,
  decision: "APPROVED" | "REJECTED",
  restoreId: string,
  decidedById: string,
): Promise<void> {
  const { db, now } = deps;
  if (decision === "REJECTED") {
    await db.fullRestore.updateMany({
      where: { id: restoreId, status: "PENDING_APPROVAL" },
      data: { status: "REJECTED", finishedAt: now(), detail: "Rejected by an Admin." },
    });
    return;
  }
  await db.fullRestore.updateMany({
    where: { id: restoreId, status: "QUEUED" },
    data: { approvedById: decidedById },
  });
  void dispatchRestores(deps);
}

/**
 * A request closed without our hook (rejected as out of date because the backup or site
 * changed): close the restore too.
 */
export async function reconcileRestores(db: Db, at: Date): Promise<void> {
  const waiting = await db.fullRestore.findMany({
    where: { status: "PENDING_APPROVAL", approvalId: { not: null } },
    select: { id: true, approvalId: true },
  });
  if (waiting.length === 0) return;
  const closed = await db.approvalRequest.findMany({
    where: {
      id: { in: waiting.flatMap((w) => (w.approvalId ? [w.approvalId] : [])) },
      status: "REJECTED",
    },
    select: { id: true, comment: true },
  });
  for (const req of closed) {
    await db.fullRestore.updateMany({
      where: { approvalId: req.id, status: "PENDING_APPROVAL" },
      data: {
        status: "REJECTED",
        finishedAt: at,
        detail: req.comment?.slice(0, 300) || "Rejected by an Admin.",
      },
    });
  }
}

/** Withdraw a restore that hasn't started; its approval request is closed too. */
export async function cancelRestore(
  deps: BackupDeps,
  restoreId: string,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "restore_started" }> {
  const { db, now } = deps;
  const row = await db.fullRestore.findUnique({
    where: { id: restoreId },
    include: { environment: { select: { siteId: true, kind: true } } },
  });
  if (!row) return { ok: false, error: "not_found" };
  const at = now();
  const done = await db.fullRestore.updateMany({
    where: { id: restoreId, status: { in: ["PENDING_APPROVAL", "QUEUED"] } },
    data: { status: "CANCELLED", finishedAt: at, detail: "Cancelled before it started." },
  });
  if (done.count !== 1) return { ok: false, error: "restore_started" };
  if (row.approvalId)
    await db.approvalRequest.updateMany({
      where: { id: row.approvalId, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedById: actor.userId,
        decidedAt: at,
        comment: "Cancelled: the restore was withdrawn",
      },
    });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.backup.restore.cancel",
      result: "success",
      ip: actor.ip,
      siteIds: [row.environment.siteId],
      meta: { kind: row.environment.kind, restoreId, wasStatus: row.status },
    },
    at,
  );
  return { ok: true };
}

// ---- Running -------------------------------------------------------------------------------

export async function expireStaleRestores(db: Db, at: Date, all = false): Promise<number> {
  const { count } = await db.fullRestore.updateMany({
    where: {
      status: "RUNNING",
      ...(all ? {} : { startedAt: { lt: new Date(at.getTime() - STALE_RESTORE_MS) } }),
    },
    data: {
      status: "FAILED",
      finishedAt: at,
      phase: null,
      detail:
        "Interrupted: the hub restarted while this restore was running. Check the site; restore the safety copy if it's broken.",
    },
  });
  return count;
}

/** Claims the site like other jobs do (A60), so deploys, updates and uptime stand aside. */
async function claim(db: Db, environmentId: string, at: Date): Promise<string | null> {
  const token = randomUUID();
  try {
    await db.siteEnvironmentLock.create({ data: { environmentId, token, lockedAt: at } });
    return token;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
      throw error;
  }
  return null;
}

let dispatching: Promise<void> = Promise.resolve();

/** Starts the oldest approved restore when nothing long is running. */
export function dispatchRestores(deps: BackupDeps): Promise<void> {
  dispatching = dispatching
    .then(() => dispatchOnce(deps))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "restore_dispatch_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  return dispatching;
}

async function dispatchOnce(deps: BackupDeps): Promise<void> {
  const { db, now } = deps;
  const at = now();
  await expireStaleRestores(db, at);
  await reconcileRestores(db, at);
  if ((await db.fullRestore.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.fullBackup.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.malwareScan.count({ where: { status: "RUNNING" } })) > 0) return;
  const next = await db.fullRestore.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    include: restoreInclude,
  });
  if (!next) return;
  const env = await db.siteEnvironment.findUnique({
    where: { id: next.environmentId },
    include: { site: { select: { id: true, name: true, archived: true } } },
  });
  const unusable =
    !env?.hostKey || env.site.archived
      ? env?.site.archived
        ? "The site was archived before the restore started."
        : "The site's connection isn't tested (no pinned host key)."
      : next.source.status !== "READY" || !next.source.driveFileId
        ? "The backup was replaced or removed from Google Drive before the restore started."
        : null;
  if (unusable || !env?.hostKey) {
    await db.fullRestore.updateMany({
      where: { id: next.id, status: "QUEUED" },
      data: { status: "FAILED", finishedAt: at, detail: unusable ?? "The site is gone." },
    });
    return dispatchOnce(deps);
  }
  // Another job (a deploy, an update) holds the site: try again on the next tick.
  const token = await claim(db, env.id, at);
  if (!token) return;
  const started = await db.fullRestore.updateMany({
    where: { id: next.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: at, phase: "checking", progress: 0 },
  });
  if (started.count !== 1) {
    await db.siteEnvironmentLock.deleteMany({ where: { environmentId: env.id, token } });
    return;
  }
  await audit(
    db,
    {
      userId: next.requestedById,
      action: "site.backup.restore.start",
      result: "pending",
      ip: null,
      siteIds: [env.site.id],
      meta: { kind: env.kind, restoreId: next.id, backupId: next.sourceId, scope: next.scope },
    },
    at,
  );
  const restoreId = next.id;
  void runRestore(deps, next, { ...env, hostKey: env.hostKey }, token)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "restore_crashed",
          restoreId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => {
      void db.siteEnvironmentLock
        .deleteMany({ where: { environmentId: env.id, token } })
        .catch(() => undefined)
        .then(() => dispatchRestores(deps));
    });
}

type EnvPinned = SiteEnvironment & {
  hostKey: string;
  site: { id: string; name: string; archived: boolean };
};

async function runRestore(
  deps: BackupDeps,
  row: RestoreRow,
  env: EnvPinned,
  token: string,
): Promise<void> {
  const { db, now } = deps;
  const where = { id: row.id, status: "RUNNING" };
  const label = `${env.site.name} (${env.kind.toLowerCase()})`;
  const actor = { userId: row.requestedById, ip: null };
  const start = now();
  const safety = await db.fullBackup.create({
    data: {
      environmentId: env.id,
      status: "RUNNING",
      purpose: "SAFETY",
      requestedById: row.requestedById,
      queuedAt: start,
      startedAt: start,
      expiresAt: new Date(start.getTime() + SAFETY_COPY_DAYS * DAY_MS),
      detail: "Safety copy taken before a restore.",
    },
  });
  await db.fullRestore.update({ where: { id: row.id }, data: { safetyBackupId: safety.id } });
  const beat = setInterval(() => {
    void db.siteEnvironmentLock
      .updateMany({ where: { environmentId: env.id, token }, data: { lockedAt: now() } })
      .catch(() => undefined);
  }, LOCK_BEAT_MS);
  beat.unref();

  let write: Promise<unknown> = Promise.resolve();
  const onProgress = (data: unknown) => {
    const p = RestoreProgress.safeParse(data);
    if (!p.success) return;
    write = write
      .then(() =>
        db.fullRestore.updateMany({
          where,
          data: { phase: p.data.phase, progress: p.data.percent },
        }),
      )
      .catch(() => undefined);
  };

  const finish = async (
    ok: boolean,
    detail: string,
    result: { changed: boolean; safety: boolean; health: { ok: boolean; summary: string } | null },
  ) => {
    const at = now();
    await db.fullRestore.updateMany({
      where,
      data: {
        status: ok ? "SUCCEEDED" : "FAILED",
        finishedAt: at,
        phase: null,
        progress: ok ? 100 : undefined,
        detail: detail.slice(0, 2000),
        healthOk: result.health?.ok ?? null,
        healthSummary: result.health?.summary.slice(0, 500) ?? null,
      },
    });
    await audit(
      db,
      {
        userId: actor.userId,
        action: "site.backup.restore.result",
        result: ok ? "success" : "failure",
        ip: null,
        siteIds: [env.site.id],
        meta: {
          kind: env.kind,
          restoreId: row.id,
          backupId: row.sourceId,
          scope: row.scope,
          safetyBackupId: result.safety ? safety.id : null,
          changed: result.changed,
          healthy: result.health?.ok ?? null,
          detail: detail.slice(0, 300),
        },
      },
      at,
    );
    const healthText = result.health
      ? result.health.ok
        ? " The site passed its health check afterwards."
        : ` The site failed its health check afterwards (${result.health.summary}).`
      : "";
    await deps.notifier.notify?.({
      kind: ok ? "restore.succeeded" : "restore.failed",
      title: ok ? `Restored: ${label}` : `Restore failed: ${label}`,
      body: `${detail}${healthText}`,
      severity: ok ? (result.health?.ok === false ? "warning" : "info") : "critical",
      siteIds: [env.site.id],
      scope: env.id,
    });
  };

  let raw: unknown;
  try {
    raw = await deps.runner.run(
      {
        type: "site.backup.restore",
        target: {
          host: env.sshHost,
          port: env.sshPort,
          user: env.sshUser,
          wpPath: env.wpPath,
          credentialRef: env.credentialRef,
          hostKey: env.hostKey,
        },
        restoreId: row.id,
        driveFileId: row.source.driveFileId ?? "",
        sourceBackupId: row.source.id,
        scope: row.scope as RestoreScope,
        ...rewriteFor(row, env),
        safetyBackupId: safety.id,
        folderKey: env.id,
        folderName: label.slice(0, 120),
        fileStem: `${backupSlug(env.site.name)}-${env.kind.toLowerCase()}`,
        ...(row.source.bytes > 0n ? { expectedBytes: Number(row.source.bytes) } : {}),
      },
      RESTORE_JOB_TIMEOUT_MS,
      { onProgress },
    );
  } catch (error) {
    await write;
    clearInterval(beat);
    await db.fullBackup.update({
      where: { id: safety.id },
      data: { status: "FAILED", finishedAt: now(), phase: null },
    });
    const why =
      error instanceof RunnerUnavailableError
        ? "The runner did not answer in time."
        : error instanceof RunnerJobFailedError
          ? error.message
          : "The restore crashed.";
    // Unknown how far it got: check the site.
    const health = await checkHealth(deps, env);
    return finish(false, `${why} The site may be partly restored; check it.`, {
      changed: true,
      safety: false,
      health,
    });
  }
  await write;
  clearInterval(beat);
  const parsed = RestoreJobResult.safeParse(raw);
  if (!parsed.success || parsed.data.hostKeyMismatch) {
    await db.fullBackup.update({
      where: { id: safety.id },
      data: { status: "FAILED", finishedAt: now(), phase: null },
    });
    return finish(
      false,
      parsed.success
        ? "Refused: the server's SSH host key no longer matches the pinned one. Nothing was changed."
        : "The runner returned an unexpected answer.",
      { changed: false, safety: false, health: null },
    );
  }
  const result = parsed.data;
  const at = now();
  await db.fullBackup.update({
    where: { id: safety.id },
    data: result.safety
      ? {
          status: "READY",
          finishedAt: at,
          phase: null,
          progress: 100,
          bytes: BigInt(result.safety.sizeBytes),
          driveFileId: result.safety.driveFileId,
          fileName: result.safety.fileName,
          md5: result.safety.md5,
          webViewLink: result.safety.webViewLink,
        }
      : { status: "FAILED", finishedAt: at, phase: null },
  });
  const health = result.changed ? await checkHealth(deps, env) : null;
  return finish(result.ok, result.detail, {
    changed: result.changed,
    safety: Boolean(result.safety),
    health,
  });
}

/** Another environment's backup: its site address becomes this one's (A157). */
function rewriteFor(row: RestoreRow, env: { id: string; url: string }) {
  if (row.source.environmentId === env.id) return {};
  const from = siteAddress(row.source.environment.url);
  const to = siteAddress(env.url);
  return from && to ? { rewrite: { from, to } } : {};
}

/** Health check after a restore, recorded on the site like any other (A147). */
async function checkHealth(
  deps: BackupDeps,
  env: EnvPinned,
): Promise<{ ok: boolean; summary: string }> {
  let health: { ok: boolean; summary: string };
  try {
    health = await runHealth(deps, env);
  } catch {
    return { ok: false, summary: "the health check couldn't run" };
  }
  await deps.db.siteEnvironment.update({
    where: { id: env.id },
    data: {
      lastHealthAt: deps.now(),
      lastHealthOk: health.ok,
      lastHealthSummary: health.summary.slice(0, 500),
    },
  });
  return health;
}

// ---- Safety copies expire ------------------------------------------------------------------

/** Deletes safety copies past their date from Drive (A152); a failure retries next tick. */
export async function pruneSafetyCopies(deps: BackupDeps): Promise<number> {
  const { db, now } = deps;
  const at = now();
  const expired = await db.fullBackup.findMany({
    where: {
      purpose: "SAFETY",
      status: "READY",
      expiresAt: { lt: at },
      driveFileId: { not: null },
      // Never while a restore from it is waiting or running.
      restoredFrom: { none: { status: { in: OPEN } } },
    },
    include: { environment: { select: { siteId: true, kind: true } } },
    take: 50,
  });
  if (expired.length === 0) return 0;
  let result: DriveDeleteResult;
  try {
    result = DriveDeleteResult.parse(
      await deps.runner.run(
        {
          type: "drive.delete",
          fileIds: expired.flatMap((b) => (b.driveFileId ? [b.driveFileId] : [])),
        },
        120_000,
      ),
    );
  } catch {
    return 0;
  }
  const gone = new Set(result.deleted);
  const removed = expired.filter((b) => b.driveFileId && gone.has(b.driveFileId));
  if (removed.length === 0) return 0;
  await db.fullBackup.updateMany({
    where: { id: { in: removed.map((b) => b.id) } },
    data: { status: "REMOVED", removedAt: at },
  });
  await audit(
    db,
    {
      userId: null,
      action: "site.backup.safety_expired",
      result: "success",
      ip: null,
      siteIds: [...new Set(removed.map((b) => b.environment.siteId))],
      meta: { backupIds: removed.map((b) => b.id), days: SAFETY_COPY_DAYS },
    },
    at,
  );
  return removed.length;
}
