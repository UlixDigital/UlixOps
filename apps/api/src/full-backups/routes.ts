// Full backup endpoints (Phase 2 step 5, A145): Drive connection, overview, history, one backup,
// stop, schedule and per-site switch.
import {
  BackupSchedule,
  DriveAuthFinish,
  DriveAuthFinishRequest,
  DriveAuthStart,
  DriveStatusResult,
  EnvKind,
  type FullBackupList,
  type FullBackupOverview,
  type FullBackupSiteRow,
  FullBackupStatus,
  nextBackupWindow,
  RecordId,
  type RestoreOverview,
  type RestoreSource,
  SealKeyResult,
  SetBackupAuto,
  StartRestoreRequest,
} from "@ulixops/shared";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit";
import { sealTo } from "../credentials/api-keys";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import {
  cancelRestore,
  expireStaleRestores,
  reconcileRestores,
  requestRestore,
  restoreInclude,
  restoreViews,
} from "./restore";
import {
  type BackupDeps,
  backupInclude,
  backupViews,
  backupWhere,
  cancelFullBackup,
  enqueueFullBackup,
  expireStaleBackups,
  readBackupSchedule,
  readDriveRecord,
  writeBackupSchedule,
  writeDriveRecord,
} from "./service";

const FINISHED = ["READY", "FAILED", "SKIPPED", "CANCELLED", "REMOVED"];

/** /sites/:id/environments/:kind/full-backup and …/backup-auto */
export function siteBackupRouter(deps: BackupDeps): Router {
  const { db, now } = deps;
  const router = Router();

  async function loadEnv(params: { id?: unknown; kind?: unknown }) {
    const id = RecordId.safeParse(params.id);
    const kind = EnvKind.safeParse(String(params.kind ?? "").toUpperCase());
    return id.success && kind.success
      ? db.siteEnvironment.findFirst({
          where: { siteId: id.data, kind: kind.data },
          include: { site: { select: { id: true, name: true, archived: true } } },
        })
      : null;
  }

  router.post(
    "/:id/environments/:kind/full-backup",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const env = await loadEnv(req.params);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (env.site.archived) {
        res.status(409).json({ error: "site_archived" });
        return;
      }
      const queued = await enqueueFullBackup(deps, env, {
        userId: sessionOf(req).user.id,
        ip: clientIpOf(req),
      });
      if (!queued.ok) {
        res.status(409).json({ error: queued.error });
        return;
      }
      res.status(202).json({ backupId: queued.backupId, position: queued.position });
    },
  );

  router.put(
    "/:id/environments/:kind/backup-auto",
    authorize("settings.manage", deps),
    async (req, res) => {
      const body = SetBackupAuto.safeParse(req.body);
      const env = body.success ? await loadEnv(req.params) : null;
      if (!body.success || !env) {
        res
          .status(body.success ? 404 : 400)
          .json({ error: body.success ? "not_found" : "bad_request" });
        return;
      }
      await db.siteEnvironment.update({
        where: { id: env.id },
        data: { backupAutoEnabled: body.data.enabled },
      });
      await audit(
        db,
        {
          userId: sessionOf(req).user.id,
          action: "site.backup.auto",
          result: "success",
          ip: clientIpOf(req),
          siteIds: [env.site.id],
          meta: { kind: env.kind, enabled: body.data.enabled },
        },
        now(),
      );
      res.json({ ok: true });
    },
  );

  return router;
}

const HistoryQuery = z.object({
  status: FullBackupStatus.optional(),
  /** One site's backups (site overview "Last backup"). */
  siteId: RecordId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** /full-backups */
export function fullBackupsRouter(deps: BackupDeps & { publicUrl: string }): Router {
  const { db, now } = deps;
  /** Must match an "Authorized redirect URI" on the Google OAuth client exactly. */
  const redirectUri = `${deps.publicUrl.replace(/\/$/, "")}/oauth/google/callback`;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canRun = authorize("sites.refresh", deps);
  const canManage = authorize("settings.manage", deps);

  async function driveStatus() {
    try {
      return DriveStatusResult.parse(await deps.runner.run({ type: "drive.status" }, 20_000));
    } catch {
      return {
        setup: { clientId: false, clientSecret: false, key: false },
        connected: false,
        email: null,
        limit: null,
        usage: null,
        error: "The runner couldn't check Google Drive right now.",
      };
    }
  }

  router.get("/overview", canView, async (_req, res) => {
    const at = now();
    await expireStaleBackups(db, at);
    const [schedule, record, drive, active, envs] = await Promise.all([
      readBackupSchedule(db),
      readDriveRecord(db),
      driveStatus(),
      db.fullBackup.findMany({
        where: { status: { in: ["RUNNING", "QUEUED"] }, purpose: "WEEKLY" },
        orderBy: { queuedAt: "asc" },
        include: backupInclude,
      }),
      db.siteEnvironment.findMany({
        where: { site: { archived: false } },
        include: { site: { select: { id: true, name: true } } },
        orderBy: [{ site: { name: "asc" } }, { kind: "asc" }],
      }),
    ]);
    const ids = envs.map((e) => e.id);
    const [ready, finished] = await Promise.all([
      db.fullBackup.findMany({
        where: { environmentId: { in: ids }, status: "READY", purpose: "WEEKLY" },
        orderBy: { queuedAt: "desc" },
        distinct: ["environmentId"],
      }),
      db.fullBackup.findMany({
        where: {
          environmentId: { in: ids },
          status: { in: ["READY", "FAILED", "SKIPPED"] },
          purpose: "WEEKLY",
        },
        orderBy: { queuedAt: "desc" },
        distinct: ["environmentId"],
      }),
    ]);
    const readyBy = new Map(ready.map((r) => [r.environmentId, r]));
    const lastBy = new Map(finished.map((r) => [r.environmentId, r]));
    const pendingBy = new Map(active.map((r) => [r.environmentId, r]));
    const covered = new Set(
      (
        await db.siteEnvironment.findMany({ where: backupWhere(schedule), select: { id: true } })
      ).map((e) => e.id),
    );
    const nextWindow = nextBackupWindow(schedule, at).toISOString();
    const sites: FullBackupSiteRow[] = envs.map((env) => {
      const cur = readyBy.get(env.id);
      const last = lastBy.get(env.id);
      const pending = pendingBy.get(env.id);
      return {
        siteId: env.site.id,
        siteName: env.site.name,
        environment: env.kind,
        ready: Boolean(env.hostKey),
        autoBackup: env.backupAutoEnabled,
        current: cur
          ? {
              id: cur.id,
              at: (cur.finishedAt ?? cur.startedAt).toISOString(),
              bytes: Number(cur.bytes),
              fileName: cur.fileName,
              webViewLink: cur.webViewLink,
            }
          : null,
        lastProblem:
          last && last.status !== "READY"
            ? {
                id: last.id,
                status: FullBackupStatus.parse(last.status),
                at: (last.finishedAt ?? last.startedAt).toISOString(),
                detail: last.detail,
              }
            : null,
        pending: pending
          ? { id: pending.id, status: pending.status as "QUEUED" | "RUNNING" }
          : null,
        nextAutoAt:
          schedule.enabled && record && covered.has(env.id) && !pending ? nextWindow : null,
        health:
          env.lastHealthAt && env.lastHealthOk !== null
            ? {
                ok: env.lastHealthOk,
                at: env.lastHealthAt.toISOString(),
                summary: env.lastHealthSummary,
              }
            : null,
      };
    });
    const views = await backupViews(db, active);
    const lastFinished = finished.reduce<Date | null>(
      (max, r) => (r.finishedAt && (!max || r.finishedAt > max) ? r.finishedAt : max),
      null,
    );
    const body: FullBackupOverview = {
      drive: { ...drive, connectedAt: record?.connectedAt ?? null, redirectUri },
      running: views.find((v) => v.status === "RUNNING") ?? null,
      queue: views.filter((v) => v.status === "QUEUED"),
      schedule,
      sites,
      stats: {
        protected: sites.filter((s) => s.current).length,
        problems: sites.filter((s) => s.lastProblem).length,
        never: sites.filter((s) => !s.current && !s.lastProblem).length,
        totalBytes: ready.reduce((sum, r) => sum + Number(r.bytes), 0),
        lastFinishedAt: lastFinished?.toISOString() ?? null,
      },
    };
    res.json(body);
  });

  router.get("/", canView, async (req, res) => {
    const query = HistoryQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const rows = await db.fullBackup.findMany({
      where: {
        status: query.data.status ?? { in: FINISHED },
        // Safety copies are listed with their restore (A152).
        purpose: "WEEKLY",
        ...(query.data.siteId ? { environment: { siteId: query.data.siteId } } : {}),
      },
      orderBy: { queuedAt: "desc" },
      take: query.data.limit,
      include: backupInclude,
    });
    const body: FullBackupList = { backups: await backupViews(db, rows) };
    res.json(body);
  });

  router.put("/schedule", canManage, async (req, res) => {
    const body = BackupSchedule.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const saved = await writeBackupSchedule(db, body.data, user.id);
    await audit(
      db,
      {
        userId: user.id,
        action: "settings.backup_schedule",
        result: "success",
        ip: clientIpOf(req),
        meta: saved,
      },
      now(),
    );
    res.json(saved);
  });

  /** "Sign in with Google" (A146): the runner builds Google's consent URL; the browser goes there. */
  router.post("/drive/authorize", canManage, async (req, res) => {
    try {
      const start = DriveAuthStart.parse(
        await deps.runner.run({ type: "drive.auth.start", redirectUri }, 30_000),
      );
      await audit(
        db,
        {
          userId: sessionOf(req).user.id,
          action: "backup.drive.connect",
          result: "pending",
          ip: clientIpOf(req),
        },
        now(),
      );
      res.json({ authUrl: start.authUrl });
    } catch (error) {
      res.status(409).json({
        error: "runner_failed",
        message:
          error instanceof RunnerJobFailedError
            ? error.message
            : error instanceof RunnerUnavailableError
              ? "The runner did not answer in time."
              : "Google sign-in couldn't start.",
      });
    }
  });

  /** Google's reply, relayed by /oauth/google/callback: the code goes to the runner sealed. */
  router.post("/drive/authorize/finish", canManage, async (req, res) => {
    const body = DriveAuthFinishRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    let result: DriveAuthFinish;
    try {
      const pub = SealKeyResult.parse(await deps.runner.run({ type: "secrets.publicKey" }, 15_000));
      result = DriveAuthFinish.parse(
        await deps.runner.run(
          {
            type: "drive.auth.finish",
            state: body.data.state,
            keyId: pub.keyId,
            ciphertext: sealTo(pub.publicKey, body.data.code),
          },
          30_000,
        ),
      );
    } catch {
      result = {
        status: "failed",
        email: null,
        detail: "The runner couldn't finish the sign-in. Try again.",
      };
    }
    if (result.status === "connected") await writeDriveRecord(db, result.email, now(), user.id);
    await audit(
      db,
      {
        userId: user.id,
        action: "backup.drive.connect",
        result: result.status === "connected" ? "success" : "failure",
        ip: clientIpOf(req),
        meta: { email: result.email, detail: result.detail },
      },
      now(),
    );
    res.json(result);
  });

  // ---- Restore from Drive (A152) ----------------------------------------------------------

  const canRestore = authorize("backups.restore", deps);

  router.get("/restores", canView, async (_req, res) => {
    const at = now();
    await expireStaleRestores(db, at);
    await reconcileRestores(db, at);
    const [record, ready, rows] = await Promise.all([
      readDriveRecord(db),
      db.fullBackup.findMany({
        where: {
          status: "READY",
          driveFileId: { not: null },
          environment: { site: { archived: false } },
        },
        include: backupInclude,
        orderBy: { queuedAt: "desc" },
      }),
      db.fullRestore.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: restoreInclude,
      }),
    ]);
    const envs = await db.siteEnvironment.findMany({
      where: { site: { archived: false } },
      include: { site: { select: { id: true, name: true } } },
      orderBy: [{ site: { name: "asc" } }, { kind: "asc" }],
    });
    const sources: RestoreSource[] = ready
      .map((b) => ({
        backupId: b.id,
        siteId: b.environment.site.id,
        siteName: b.environment.site.name,
        environment: b.environment.kind,
        purpose: b.purpose === "SAFETY" ? ("SAFETY" as const) : ("WEEKLY" as const),
        at: (b.finishedAt ?? b.startedAt).toISOString(),
        bytes: Number(b.bytes),
        fileName: b.fileName,
        webViewLink: b.webViewLink,
        expiresAt: b.expiresAt?.toISOString() ?? null,
      }))
      .sort(
        (a, b) =>
          a.siteName.localeCompare(b.siteName) ||
          a.environment.localeCompare(b.environment) ||
          b.at.localeCompare(a.at),
      );
    const body: RestoreOverview = {
      driveConnected: Boolean(record),
      sources,
      targets: envs.map((e) => ({
        siteId: e.site.id,
        siteName: e.site.name,
        environment: e.kind,
        url: e.url,
        ready: e.hostKey !== null,
      })),
      restores: await restoreViews(db, rows),
    };
    res.json(body);
  });

  router.post("/restores", canRestore, async (req, res) => {
    const body = StartRestoreRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const asked = await requestRestore(deps, body.data, user, clientIpOf(req));
    if (!asked.ok) {
      res
        .status(asked.error === "not_found" ? 404 : asked.error === "confirm_mismatch" ? 400 : 409)
        .json({ error: asked.error });
      return;
    }
    res.status(202).json({ restoreId: asked.restoreId, selfApproved: asked.selfApproved });
  });

  router.post("/restores/:id/cancel", canRestore, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const done = await cancelRestore(deps, id.data, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    if (!done.ok) {
      res.status(done.error === "not_found" ? 404 : 409).json({ error: done.error });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/:id/cancel", canRun, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const done = await cancelFullBackup(deps, id.data, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    if (!done.ok) {
      res.status(done.error === "not_found" ? 404 : 409).json({ error: done.error });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
