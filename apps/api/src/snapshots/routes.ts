// Quick snapshots + restore + plugin update with pre-update snapshot (Build Order step 8).
import { randomUUID } from "node:crypto";
import {
  type BackupList,
  type BackupView,
  BulkUpdateRequest,
  type BulkUpdateResponse,
  type BulkUpdateStatusResponse,
  CreateSnapshotRequest,
  EnvKind,
  isMajorVersionBump,
  type PluginUpdateResponse,
  RecordId,
  RemoteCommandResult,
  SITE_JOB_STALE_MS,
  siteActionPermission,
  type SnapshotActionResponse,
  type SnapshotAsset,
  SnapshotJobResult,
  SiteInventoryResult,
  UpdatePluginRequest,
  UpdateThemeRequest,
  type SiteJobView,
  UpdateCoreRequest,
  DeletePluginRequest,
  DeleteThemeRequest,
  type CoreUpdateResponse,
  CoreVersion,
  versionJumpSafety,
  BulkUpdateRunProgress,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { raiseAlert } from "../alerts";
import { audit } from "../audit";
import type { Db } from "../db";
import {
  Prisma,
  type Backup,
  type Site,
  type SiteEnvironment,
  type SiteJob,
} from "../generated/prisma/client";
import { authorize, clientIpOf, permitted, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { coreUpdateFields, items, jobSummary } from "../sites/operations";
import {
  type BulkPlannedItem,
  executeBulkUpdateRun,
  onBulkUpdateApproved,
  runHealth,
} from "./bulk-update-run";
import type { VisualStore } from "../visual/store";
import { purgeExpired, readRetentionDays } from "./retention";
import type { SnapshotStore } from "./store";
import { afterInventoryChange } from "../vulnerabilities/service";

const SNAPSHOT_TIMEOUT_MS = 180_000;
/** How long a finished bulk update report stays on the Plugins & themes tab (A136). */
const REPORT_KEEP_MS = 24 * 60 * 60_000;
// The runner's own cap is 300 s; on top come the SSH Gateway connect and a busy runner queue
// (A136: Elementor timed out here at 330 s while the update itself was still running).
const UPDATE_TIMEOUT_MS = 420_000;
const MAX_OUTPUT = 20_000;

export interface SnapshotDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
  snapshots: SnapshotStore;
  /** Fallback when the Setting row is missing (SNAPSHOT_RETENTION_DAYS). */
  defaultRetentionDays: number;
  /** Before/after screenshots around bulk updates (A163). */
  visualStore?: VisualStore;
}

export function snapshotSiteRouter(deps: SnapshotDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const BackupStatus = z.enum(["PENDING", "READY", "FAILED", "EXPIRED"]);

  async function emails(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    const users = wanted.length
      ? await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } })
      : [];
    return new Map(users.map((u) => [u.id, u]));
  }

  async function backupView(
    row: Backup & { site: { name: string }; environment: { kind: EnvKind } },
    users: Map<string, { id: string; email: string }>,
  ): Promise<BackupView> {
    return {
      id: row.id,
      siteId: row.siteId,
      siteName: row.site.name,
      kind: row.kind === "FULL" ? "FULL" : "QUICK_SNAPSHOT",
      status: BackupStatus.parse(row.status),
      environment: row.environment.kind,
      pluginName: row.pluginName,
      pluginVersion: row.pluginVersion,
      includesDb: row.includesDb,
      sizeBytes: row.sizeBytes,
      encrypted: row.encrypted,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      restoredAt: row.restoredAt?.toISOString() ?? null,
      createdBy: row.createdById ? (users.get(row.createdById) ?? null) : null,
    };
  }

  async function load(
    req: Request,
    res: Response,
  ): Promise<{ site: Site; env: SiteEnvironment } | null> {
    const id = RecordId.safeParse(req.params.id);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    const site =
      id.success && kind.success
        ? await db.site.findUnique({
            where: { id: id.data },
            include: { environments: { where: { kind: kind.data } } },
          })
        : null;
    const env = site?.environments[0];
    if (!site || !env) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return { site, env };
  }

  async function ready(res: Response, site: Site, env: SiteEnvironment): Promise<boolean> {
    if (site.archived) {
      res.status(409).json({ error: "site_archived" });
      return false;
    }
    if (!env.hostKey) {
      res.status(409).json({ error: "connection_untested" });
      return false;
    }
    return true;
  }

  async function claim(environmentId: string): Promise<string | null> {
    const token = randomUUID();
    const at = now();
    try {
      await db.siteEnvironmentLock.create({ data: { environmentId, token, lockedAt: at } });
      return token;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
        throw error;
    }
    const taken = await db.siteEnvironmentLock.updateMany({
      where: { environmentId, lockedAt: { lt: new Date(at.getTime() - SITE_JOB_STALE_MS) } },
      data: { token, lockedAt: at },
    });
    return taken.count === 1 ? token : null;
  }

  const release = (environmentId: string, token: string) =>
    db.siteEnvironmentLock.deleteMany({ where: { environmentId, token } });

  const targetOf = (env: SiteEnvironment & { hostKey: string }) => ({
    host: env.sshHost,
    port: env.sshPort,
    user: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
  });
  const pinned = (env: SiteEnvironment): env is SiteEnvironment & { hostKey: string } =>
    env.hostKey !== null;

  const cap = (text: string) =>
    text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}… (truncated)` : text;

  function jobView(
    job: SiteJob & { environment: { kind: EnvKind } },
    users: Map<string, { id: string; email: string }>,
  ) {
    return {
      id: job.id,
      kind: job.environment.kind,
      action: job.action,
      summary: jobSummary(job.action, job.params),
      status: job.status,
      interrupted:
        job.status === "RUNNING" && now().getTime() - job.startedAt.getTime() > SITE_JOB_STALE_MS,
      exitCode: job.exitCode,
      output: job.output,
      requestedBy: job.requestedById ? (users.get(job.requestedById) ?? null) : null,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      durationMs: job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : null,
    };
  }

  async function runRemoteJob(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    action: string,
    params: Prisma.InputJsonObject,
    call: () => Promise<unknown>,
    finish: (raw: unknown) => Promise<{
      ok: boolean;
      exitCode: number | null;
      output: string;
      hostKeyMismatch: boolean;
    }>,
  ) {
    const userId = sessionOf(req).user.id;
    const job = await db.siteJob.create({
      data: {
        siteId: site.id,
        environmentId: env.id,
        action,
        params,
        requestedById: userId,
        startedAt: now(),
      },
    });
    let outcome: { ok: boolean; exitCode: number | null; output: string; error?: string };
    let hostKeyMismatch = false;
    try {
      const finished = await finish(await call());
      hostKeyMismatch = finished.hostKeyMismatch;
      outcome = finished;
    } catch (error) {
      if (error instanceof RunnerUnavailableError) {
        outcome = {
          ok: false,
          exitCode: null,
          output:
            "The runner didn't answer in time. The command may still have run: refresh the inventory to check.",
          error: "runner_unavailable",
        };
      } else if (error instanceof RunnerJobFailedError) {
        outcome = { ok: false, exitCode: null, output: error.message, error: "runner_failed" };
      } else {
        await db.siteJob.update({
          where: { id: job.id },
          data: { status: "FAILED", finishedAt: now(), output: "Internal error" },
        });
        throw error;
      }
    }
    const finished = await db.siteJob.update({
      where: { id: job.id },
      data: {
        status: outcome.ok ? "SUCCEEDED" : "FAILED",
        exitCode: outcome.exitCode,
        output: cap(outcome.output),
        finishedAt: now(),
      },
      include: { environment: { select: { kind: true } } },
    });
    await audit(
      db,
      {
        userId,
        action: `site.${action}`,
        result: outcome.ok ? "success" : "failure",
        ip: clientIpOf(req),
        siteIds: [site.id],
        meta: {
          kind: env.kind,
          jobId: job.id,
          ...params,
          ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      },
      now(),
    );
    if (hostKeyMismatch) {
      await raiseAlert(
        db,
        deps.notifier,
        { kind: "HOST_KEY_MISMATCH", userId, ip: clientIpOf(req) ?? "unknown", userAgent: "" },
        now(),
      );
    }
    return { job: jobView(finished, await emails([userId])), hostKeyMismatch };
  }

  router.get("/:id/environments/:kind/snapshots", canView, async (req, res) => {
    const found = await load(req, res);
    if (!found) return;
    await purgeExpired(db, deps.snapshots, now());
    const rows = await db.backup.findMany({
      where: {
        environmentId: found.env.id,
        status: { in: ["READY", "FAILED", "PENDING"] },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { site: { select: { name: true } }, environment: { select: { kind: true } } },
    });
    const users = await emails(rows.map((r) => r.createdById));
    const body: z.infer<typeof BackupList> = {
      backups: await Promise.all(rows.map((r) => backupView(r, users))),
    };
    res.json(body);
  });

  router.post("/:id/environments/:kind/snapshots", async (req, res) => {
    const body = CreateSnapshotRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("snapshot.create", kind.data), deps)))
      return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      const result = await createSnapshot(
        req,
        site,
        env,
        body.data.plugin,
        body.data.includeDb,
        body.data.asset,
      );
      res.json(result);
    } finally {
      await release(env.id, token);
    }
  });

  async function createSnapshot(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    plugin: string,
    includeDb: boolean,
    asset: SnapshotAsset = "plugin",
  ): Promise<z.infer<typeof SnapshotActionResponse>> {
    await purgeExpired(db, deps.snapshots, now());
    const days = await readRetentionDays(db, deps.defaultRetentionDays);
    const userId = sessionOf(req).user.id;
    const expiresAt = new Date(now().getTime() + days * 86_400_000);
    // Row first so we have a backup id; blob location comes back from the runner (A103).
    const row = await db.backup.create({
      data: {
        siteId: site.id,
        environmentId: env.id,
        kind: "QUICK_SNAPSHOT",
        status: "PENDING",
        pluginName: plugin,
        includesDb: includeDb,
        location: "pending",
        encrypted: true,
        expiresAt,
        createdById: userId,
        createdAt: now(),
      },
    });

    const ran = await runRemoteJob(
      req,
      site,
      env,
      "snapshot.create",
      { plugin, includeDb, backupId: row.id, asset },
      () =>
        deps.runner.run(
          {
            type: "site.snapshot",
            target: targetOf(env),
            backupId: row.id,
            plugin,
            includeDb,
            asset,
          },
          SNAPSHOT_TIMEOUT_MS,
        ),
      async (raw) => {
        const result = SnapshotJobResult.parse(raw);
        if (result.hostKeyMismatch) {
          await db.backup.update({ where: { id: row.id }, data: { status: "FAILED" } });
          return {
            ok: false,
            exitCode: null,
            output:
              "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
            hostKeyMismatch: true,
          };
        }
        if (!result.ok || !result.sha256 || result.sizeBytes === null || !result.location) {
          await db.backup.update({ where: { id: row.id }, data: { status: "FAILED" } });
          return {
            ok: false,
            exitCode: 1,
            output: result.detail,
            hostKeyMismatch: false,
          };
        }
        await db.backup.update({
          where: { id: row.id },
          data: {
            status: "READY",
            pluginVersion: result.pluginVersion,
            includesDb: result.includesDb,
            sha256: result.sha256,
            sizeBytes: result.sizeBytes,
            location: result.location,
          },
        });
        return {
          ok: true,
          exitCode: 0,
          output: result.detail,
          hostKeyMismatch: false,
        };
      },
    );

    // Timeout / RunnerJobFailedError never reach finish(), so the row can stay PENDING.
    let updated = await db.backup.findUniqueOrThrow({
      where: { id: row.id },
      include: { site: { select: { name: true } }, environment: { select: { kind: true } } },
    });
    if (updated.status === "PENDING") {
      if (updated.location !== "pending") {
        await deps.snapshots.remove(updated.location).catch(() => undefined);
      }
      updated = await db.backup.update({
        where: { id: row.id },
        data: { status: "FAILED" },
        include: { site: { select: { name: true } }, environment: { select: { kind: true } } },
      });
    }
    return {
      ...ran,
      backup: await backupView(updated, await emails([userId])),
    };
  }

  async function restoreBackup(
    req: Request,
    res: Response,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    backup: Backup,
  ) {
    if (!backup.pluginName) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!(await deps.snapshots.exists(backup.location))) {
      res.status(409).json({ error: "snapshot_missing" });
      return;
    }
    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      const plugin = backup.pluginName;
      const ran = await runRemoteJob(
        req,
        site,
        env,
        "snapshot.restore",
        { backupId: backup.id, plugin, includesDb: backup.includesDb },
        () =>
          deps.runner.run(
            {
              type: "site.snapshot.restore",
              target: targetOf(env),
              backupId: backup.id,
              plugin,
              includesDb: backup.includesDb,
              location: backup.location !== "pending" ? backup.location : undefined,
            },
            SNAPSHOT_TIMEOUT_MS,
          ),
        async (raw) => {
          const result = SnapshotJobResult.parse(raw);
          if (result.hostKeyMismatch) {
            return {
              ok: false,
              exitCode: null,
              output:
                "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
              hostKeyMismatch: true,
            };
          }
          if (!result.ok) {
            return { ok: false, exitCode: 1, output: result.detail, hostKeyMismatch: false };
          }
          await db.backup.update({
            where: { id: backup.id },
            data: { restoredAt: now() },
          });
          return { ok: true, exitCode: 0, output: result.detail, hostKeyMismatch: false };
        },
      );
      const updated = await db.backup.findUniqueOrThrow({
        where: { id: backup.id },
        include: { site: { select: { name: true } }, environment: { select: { kind: true } } },
      });
      const body: z.infer<typeof SnapshotActionResponse> = {
        ...ran,
        backup: await backupView(updated, await emails([sessionOf(req).user.id])),
      };
      res.json(body);
    } finally {
      await release(env.id, token);
    }
  }

  router.post("/:id/environments/:kind/snapshots/:backupId/restore", async (req, res) => {
    const backupId = RecordId.safeParse(req.params.backupId);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!backupId.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("snapshot.restore", kind.data), deps)))
      return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const backup = await db.backup.findFirst({
      where: { id: backupId.data, environmentId: env.id, status: "READY" },
    });
    if (!backup) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await restoreBackup(req, res, site, env, backup);
  });

  /** Restore the most recent READY snapshot for this environment ("Restore latest snapshot"). */
  router.post("/:id/environments/:kind/rollback", async (req, res) => {
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("snapshot.restore", kind.data), deps)))
      return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;
    const latest = await db.backup.findFirst({
      where: { environmentId: env.id, status: "READY", kind: "QUICK_SNAPSHOT" },
      orderBy: { createdAt: "desc" },
    });
    if (!latest) {
      res.status(404).json({ error: "no_snapshot" });
      return;
    }
    await restoreBackup(req, res, site, env, latest);
  });

  async function updateOneAsset(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    asset: SnapshotAsset,
    name: string,
    fromVersion: string,
    toVersion: string,
    includeDbForce: boolean | undefined,
  ): Promise<{
    snap: z.infer<typeof SnapshotActionResponse>;
    update: {
      job: z.infer<typeof PluginUpdateResponse>["updateJob"];
      hostKeyMismatch: boolean;
    } | null;
  }> {
    const includeDb = includeDbForce ?? isMajorVersionBump(fromVersion, toVersion);
    const snap = await createSnapshot(req, site, env, name, includeDb, asset);
    if (!snap.job || snap.job.status !== "SUCCEEDED" || snap.hostKeyMismatch) {
      return { snap, update: null };
    }
    const op = asset === "theme" ? ("theme.update" as const) : ("plugin.update" as const);
    const update = await runRemoteJob(
      req,
      site,
      env,
      op,
      { plugin: name, asset, includeDb, backupId: snap.backup?.id ?? null },
      () =>
        deps.runner.run(
          {
            type: "remote.command",
            target: targetOf(env),
            command: { op, slug: name },
          },
          UPDATE_TIMEOUT_MS,
        ),
      async (raw) => {
        const out = RemoteCommandResult.parse(raw);
        if (out.hostKeyMismatch) {
          return {
            ok: false,
            exitCode: null,
            output:
              "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
            hostKeyMismatch: true,
          };
        }
        const ok = out.exitCode === 0;
        return {
          ok,
          exitCode: out.exitCode,
          output: [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n"),
          hostKeyMismatch: false,
        };
      },
    );
    return { snap, update: { job: update.job, hostKeyMismatch: update.hostKeyMismatch } };
  }

  /** Refresh inventory while the caller already holds the env lock (A104). */
  async function refreshInventoryLocked(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
  ): Promise<boolean> {
    try {
      const raw = await deps.runner.run(
        { type: "site.inventory", target: targetOf(env), checkUpdates: true },
        180_000,
      );
      const result = SiteInventoryResult.parse(raw);
      if (result.hostKeyMismatch) return false;
      const data = {
        refreshedAt: now(),
        refreshedById: sessionOf(req).user.id,
        wpVersion: result.wpVersion,
        phpVersion: result.phpVersion,
        wpCliVersion: result.wpCliVersion,
        activeTheme: result.themes.find((t) => t.status === "active")?.name ?? null,
        maintenance: result.maintenance,
        safeMode: result.safeMode,
        warnings: result.warnings,
        plugins: result.plugins,
        themes: result.themes,
        ...coreUpdateFields(result, null, now()),
      };
      await db.siteInventory.upsert({
        where: { environmentId: env.id },
        create: { environmentId: env.id, ...data },
        update: data,
      });
      await db.siteEnvironment.update({
        where: { id: env.id },
        data: {
          wpVersion: result.wpVersion,
          phpVersion: result.phpVersion,
          wpCliVersion: result.wpCliVersion,
        },
      });
      await afterInventoryChange(deps, env.id);
      await audit(
        db,
        {
          userId: sessionOf(req).user.id,
          action: "site.inventory.refresh",
          result: "success",
          ip: clientIpOf(req),
          siteIds: [site.id],
          meta: { kind: env.kind, after: "update" },
        },
        now(),
      );
      return true;
    } catch {
      return false;
    }
  }

  router.post("/:id/environments/:kind/plugins/update", async (req, res) => {
    const body = UpdatePluginRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("plugin.update", kind.data), deps)))
      return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    const plugin = items(inv?.plugins ?? []).find((p) => p.name === body.data.plugin);
    if (!plugin) {
      res.status(404).json({ error: "plugin_not_in_inventory" });
      return;
    }
    if (!plugin.updateVersion) {
      res.status(409).json({ error: "no_update_available" });
      return;
    }

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      const { snap, update } = await updateOneAsset(
        req,
        site,
        env,
        "plugin",
        body.data.plugin,
        plugin.version,
        plugin.updateVersion,
        body.data.includeDb,
      );
      if (update?.job?.status === "SUCCEEDED") {
        await refreshInventoryLocked(req, site, env);
      }
      const bodyOut: z.infer<typeof PluginUpdateResponse> = {
        job: snap.job,
        hostKeyMismatch: update?.hostKeyMismatch ?? snap.hostKeyMismatch,
        backup: snap.backup,
        updateJob: update?.job ?? null,
      };
      res.json(bodyOut);
    } finally {
      await release(env.id, token);
    }
  });

  /**
   * WordPress core update (A135): exact version the last update check offered → database
   * upgrade → health check → on failure, downgrade to the previous version and check again.
   * Core files are restored by re-installing the old release (no file snapshot of core).
   */
  router.post("/:id/environments/:kind/core/update", async (req, res) => {
    const body = UpdateCoreRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("core.update", kind.data), deps))) return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    if (!inv?.coreUpdateVersion) {
      res.status(409).json({ error: "no_update_available" });
      return;
    }
    // Only the release the user saw: anything else means the page is out of date.
    if (inv.coreUpdateVersion !== body.data.version) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    const fromVersion = inv.wpVersion;
    const toVersion = body.data.version;
    const canRollBack = CoreVersion.safeParse(fromVersion).success;

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    const jobs: z.infer<typeof CoreUpdateResponse>["jobs"] = [];
    const runCore = async (
      action: string,
      command: { op: "core.update"; version: string; force?: boolean } | { op: "core.update-db" },
      params: Prisma.InputJsonObject,
    ) => {
      const ran = await runRemoteJob(
        req,
        site,
        env,
        action,
        params,
        () =>
          deps.runner.run(
            { type: "remote.command", target: targetOf(env), command },
            UPDATE_TIMEOUT_MS,
          ),
        async (raw) => {
          const out = RemoteCommandResult.parse(raw);
          if (out.hostKeyMismatch)
            return {
              ok: false,
              exitCode: null,
              output:
                "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
              hostKeyMismatch: true,
            };
          return {
            ok: out.exitCode === 0,
            exitCode: out.exitCode,
            output: [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n"),
            hostKeyMismatch: false,
          };
        },
      );
      if (ran.job) jobs.push(ran.job);
      return ran.job?.status === "SUCCEEDED" && !ran.hostKeyMismatch;
    };
    const health = async () => {
      try {
        return await runHealth(deps, env);
      } catch {
        return { ok: false, summary: "The health check could not run." };
      }
    };
    const finish = async (status: z.infer<typeof CoreUpdateResponse>["status"], detail: string) => {
      await refreshInventoryLocked(req, site, env);
      await audit(
        db,
        {
          userId: sessionOf(req).user.id,
          action: "site.core.update.result",
          result: status === "updated" ? "success" : "failure",
          ip: clientIpOf(req),
          siteIds: [site.id],
          meta: { kind: env.kind, fromVersion, toVersion, status },
        },
        now(),
      );
      if (status !== "updated" && deps.notifier.notify)
        await deps.notifier.notify({
          kind: status === "failed" ? "bulk_update.failed" : "deployment.rolled_back",
          title:
            status === "rolled_back"
              ? `WordPress update rolled back on ${site.name}`
              : `WordPress update failed on ${site.name}`,
          body: `${site.name} (${env.kind.toLowerCase()}): WordPress ${fromVersion} → ${toVersion}. ${detail}`,
          severity: status === "rollback_failed" ? "critical" : "warning",
          siteIds: [site.id],
        });
      const out: z.infer<typeof CoreUpdateResponse> = {
        status,
        fromVersion,
        toVersion,
        detail: detail.slice(0, 2000),
        jobs,
      };
      res.json(out);
    };

    try {
      if (
        !(await runCore(
          "core.update",
          { op: "core.update", version: toVersion },
          { fromVersion, toVersion },
        ))
      ) {
        await finish(
          "failed",
          "WP-CLI could not update WordPress; nothing was changed. See the job log.",
        );
        return;
      }
      // Major releases need the database upgrade; on minor ones it is a quick no-op.
      await runCore("core.update-db", { op: "core.update-db" }, { toVersion });
      const after = await health();
      if (after.ok) {
        await finish("updated", `Healthy on WordPress ${toVersion}. ${after.summary}`);
        return;
      }
      if (!canRollBack) {
        await finish(
          "rollback_failed",
          `Health check failed (${after.summary}) and ${fromVersion} can't be re-installed automatically. Check the site now.`,
        );
        return;
      }
      const restored = await runCore(
        "core.rollback",
        { op: "core.update", version: fromVersion, force: true },
        { fromVersion: toVersion, toVersion: fromVersion, reason: "health check failed" },
      );
      const again = restored ? await health() : { ok: false, summary: "rollback failed" };
      await finish(
        restored && again.ok ? "rolled_back" : "rollback_failed",
        restored && again.ok
          ? `Health check failed on ${toVersion} (${after.summary}); WordPress ${fromVersion} was re-installed and the site is healthy again.`
          : `Health check failed on ${toVersion} (${after.summary}) and the rollback to ${fromVersion} did not bring it back (${again.summary}). Check the site now: Emergency tab.`,
      );
    } finally {
      await release(env.id, token);
    }
  });

  /**
   * Delete an inactive plugin or theme (A137): snapshot its folder first (restorable from
   * Snapshots & backups), then `wp plugin|theme delete`, then re-read the inventory.
   */
  async function deleteAsset(req: Request, res: Response, asset: SnapshotAsset, name: string) {
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const action = asset === "theme" ? ("theme.delete" as const) : ("plugin.delete" as const);
    if (!(await permitted(req, res, siteActionPermission(action, kind.data), deps))) return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    const list = items((asset === "theme" ? inv?.themes : inv?.plugins) ?? []);
    const item = list.find((i) => i.name === name);
    if (!item) {
      res
        .status(404)
        .json({ error: asset === "theme" ? "theme_not_in_inventory" : "plugin_not_in_inventory" });
      return;
    }
    // Active, network-active, parent-of-active, must-use and drop-ins are never deleted here.
    if (item.status !== "inactive") {
      res.status(409).json({ error: "still_active" });
      return;
    }

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      const snap = await createSnapshot(req, site, env, name, false, asset);
      let deleted: { job: SiteJobView | null; hostKeyMismatch: boolean } | null = null;
      if (snap.job?.status === "SUCCEEDED" && !snap.hostKeyMismatch) {
        deleted = await runRemoteJob(
          req,
          site,
          env,
          action,
          { plugin: name, asset, version: item.version, backupId: snap.backup?.id ?? null },
          () =>
            deps.runner.run({
              type: "remote.command",
              target: targetOf(env),
              command: { op: action, slug: name },
            }),
          async (raw) => {
            const out = RemoteCommandResult.parse(raw);
            if (out.hostKeyMismatch)
              return {
                ok: false,
                exitCode: null,
                output:
                  "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
                hostKeyMismatch: true,
              };
            return {
              ok: out.exitCode === 0,
              exitCode: out.exitCode,
              output: [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n"),
              hostKeyMismatch: false,
            };
          },
        );
        if (deleted.job?.status === "SUCCEEDED") await refreshInventoryLocked(req, site, env);
      }
      const body: z.infer<typeof PluginUpdateResponse> = {
        job: snap.job,
        hostKeyMismatch: deleted?.hostKeyMismatch ?? snap.hostKeyMismatch,
        backup: snap.backup,
        updateJob: deleted?.job ?? null,
      };
      res.json(body);
    } finally {
      await release(env.id, token);
    }
  }

  router.post("/:id/environments/:kind/plugins/delete", async (req, res) => {
    const body = DeletePluginRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    await deleteAsset(req, res, "plugin", body.data.plugin);
  });

  router.post("/:id/environments/:kind/themes/delete", async (req, res) => {
    const body = DeleteThemeRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    await deleteAsset(req, res, "theme", body.data.theme);
  });

  router.post("/:id/environments/:kind/themes/update", async (req, res) => {
    const body = UpdateThemeRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("theme.update", kind.data), deps))) return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    const theme = items(inv?.themes ?? []).find((t) => t.name === body.data.theme);
    if (!theme) {
      res.status(404).json({ error: "theme_not_in_inventory" });
      return;
    }
    if (!theme.updateVersion) {
      res.status(409).json({ error: "no_update_available" });
      return;
    }

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      const { snap, update } = await updateOneAsset(
        req,
        site,
        env,
        "theme",
        body.data.theme,
        theme.version,
        theme.updateVersion,
        body.data.includeDb,
      );
      if (update?.job?.status === "SUCCEEDED") {
        await refreshInventoryLocked(req, site, env);
      }
      const bodyOut: z.infer<typeof PluginUpdateResponse> = {
        job: snap.job,
        hostKeyMismatch: update?.hostKeyMismatch ?? snap.hostKeyMismatch,
        backup: snap.backup,
        updateJob: update?.job ?? null,
      };
      res.json(bodyOut);
    } finally {
      await release(env.id, token);
    }
  });

  async function runBulkUpdate(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    planned: BulkPlannedItem[],
  ): Promise<z.infer<typeof BulkUpdateResponse>> {
    const { results, progress, inventoryRefreshed } = await executeBulkUpdateRun(deps, {
      site,
      env,
      items: planned,
      actorUserId: sessionOf(req).user.id,
      onProgress: async () => {
        // Immediate (non-approval) runs block the HTTP request; progress is returned at the end.
      },
    });
    return {
      approvalId: null,
      status: "completed",
      results,
      inventoryRefreshed,
      reportMarkdown: progress.reportMarkdown ?? undefined,
    };
  }

  router.post("/:id/environments/:kind/bulk-update", async (req, res) => {
    const body = BulkUpdateRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission("plugin.update", kind.data), deps)))
      return;
    if (body.data.strategy === "google_drive") {
      const out: z.infer<typeof BulkUpdateResponse> = {
        approvalId: null,
        status: "rejected_strategy",
        results: [],
        inventoryRefreshed: false,
      };
      res.status(409).json({ error: "google_drive_unavailable", ...out });
      return;
    }
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    if (!inv) {
      res.status(409).json({ error: "no_inventory" });
      return;
    }
    const outdated: BulkPlannedItem[] = [
      ...items(inv.plugins).flatMap((p) =>
        p.updateVersion
          ? [
              {
                asset: "plugin" as const,
                name: p.name,
                version: p.version,
                updateVersion: p.updateVersion,
                safety: versionJumpSafety(p.version, p.updateVersion),
              },
            ]
          : [],
      ),
      ...items(inv.themes).flatMap((t) =>
        t.updateVersion
          ? [
              {
                asset: "theme" as const,
                name: t.name,
                version: t.version,
                updateVersion: t.updateVersion,
                safety: versionJumpSafety(t.version, t.updateVersion),
              },
            ]
          : [],
      ),
    ];
    let planned = outdated;
    if (body.data.items && body.data.items.length > 0) {
      const wanted = new Set(body.data.items.map((i) => `${i.asset}:${i.name}`));
      planned = outdated.filter((i) => wanted.has(`${i.asset}:${i.name}`));
    }
    if (planned.length === 0) {
      res.status(409).json({ error: "no_updates_available" });
      return;
    }

    // A running approved bulk holds the env lock — don't queue another request (A105).
    const locked = await db.siteEnvironmentLock.findUnique({ where: { environmentId: env.id } });
    if (locked) {
      res.status(409).json({ error: "site_busy" });
      return;
    }

    const needsApproval = kind.data === "PRODUCTION" && planned.length >= 2;
    if (needsApproval) {
      const blocked = await bulkUpdateBlockedByPriorApproval(db, site.id, kind.data, planned);
      if (blocked) {
        res.status(409).json({ error: "bulk_update_active" });
        return;
      }
      const { user } = sessionOf(req);
      const items = planned.map((p) => ({
        asset: p.asset,
        name: p.name,
        version: p.version,
        updateVersion: p.updateVersion,
        safety: p.safety,
      }));
      const asked = await requestApproval(
        db,
        {
          action: "site.bulk_update",
          payload: {
            siteId: site.id,
            kind: kind.data,
            strategy: "snapshots",
            items: planned.map((p) => ({
              asset: p.asset,
              name: p.name,
              version: p.version,
              updateVersion: p.updateVersion,
              safety: p.safety,
            })),
            runStatus: "queued",
          },
          requestedById: user.id,
          ip: clientIpOf(req),
          requesterRole: user.role,
        },
        now(),
        deps.notifier,
      );
      if (!asked.ok) {
        res.status(409).json({ error: asked.error });
        return;
      }
      // A Super Admin's request is approved at once and the run starts in the background (A134).
      const selfApproved = await selfApproveIfAllowed(
        {
          db,
          now,
          notifier: deps.notifier,
          onBulkUpdateApproved: (_payload, decidedById, requestId, requesterId) =>
            onBulkUpdateApproved(
              deps,
              { siteId: site.id, kind: kind.data, items },
              decidedById,
              requestId,
              requesterId,
            ),
        },
        asked.id,
        user,
        clientIpOf(req),
      );
      const out: z.infer<typeof BulkUpdateResponse> = {
        approvalId: asked.id,
        status: selfApproved ? "running" : "pending_approval",
        results: [],
        inventoryRefreshed: false,
      };
      res.status(202).json(out);
      return;
    }

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    try {
      res.json(await runBulkUpdate(req, site, env, planned));
    } finally {
      await release(env.id, token);
    }
  });

  /** Live / recent bulk-update progress for the plugins page poller (A108). */
  /** Hide the last finished bulk report on this environment (A136). */
  router.post("/:id/environments/:kind/bulk-update/dismiss", async (req, res) => {
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, "sites.refresh", deps))) return;
    const found = await load(req, res);
    if (!found) return;
    const recent = await db.approvalRequest.findFirst({
      where: {
        action: "site.bulk_update",
        status: "APPROVED",
        AND: [
          { payload: { path: ["siteId"], equals: found.site.id } },
          { payload: { path: ["kind"], equals: kind.data } },
        ],
      },
      orderBy: { decidedAt: "desc" },
    });
    const payload = (recent?.payload ?? {}) as Prisma.JsonObject;
    if (!recent || (payload.runStatus !== "completed" && payload.runStatus !== "failed")) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await db.approvalRequest.update({
      where: { id: recent.id },
      data: { payload: { ...payload, dismissedAt: now().toISOString() } },
    });
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "site.bulk_update.dismiss",
        result: "success",
        ip: clientIpOf(req),
        siteIds: [found.site.id],
        meta: { kind: kind.data, requestId: recent.id },
      },
      now(),
    );
    res.json({ ok: true });
  });

  router.get("/:id/environments/:kind/bulk-update/status", canView, async (req, res) => {
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const found = await load(req, res);
    if (!found) return;
    const { site } = found;

    const pending = await db.approvalRequest.findFirst({
      where: {
        action: "site.bulk_update",
        status: "PENDING",
        AND: [
          { payload: { path: ["siteId"], equals: site.id } },
          { payload: { path: ["kind"], equals: kind.data } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      const out: BulkUpdateStatusResponse = {
        active: false,
        approvalId: pending.id,
        runStatus: "pending_approval",
        progress: null,
        reportMarkdown: null,
      };
      res.json(out);
      return;
    }

    const recent = await db.approvalRequest.findFirst({
      where: {
        action: "site.bulk_update",
        status: "APPROVED",
        AND: [
          { payload: { path: ["siteId"], equals: site.id } },
          { payload: { path: ["kind"], equals: kind.data } },
        ],
      },
      orderBy: { decidedAt: "desc" },
    });
    if (!recent) {
      const empty: BulkUpdateStatusResponse = {
        active: false,
        approvalId: null,
        runStatus: null,
        progress: null,
        reportMarkdown: null,
      };
      res.json(empty);
      return;
    }

    const payload = (recent.payload ?? {}) as {
      runStatus?: string;
      runProgress?: unknown;
      reportMarkdown?: unknown;
      dismissedAt?: unknown;
    };
    const runStatusRaw = payload.runStatus;
    // A finished report stays until dismissed, or for REPORT_KEEP_MS after the run (A136).
    if (runStatusRaw === "completed" || runStatusRaw === "failed") {
      const progress = BulkUpdateRunProgress.safeParse(payload.runProgress);
      const finishedAt = progress.success
        ? Date.parse(progress.data.updatedAt)
        : (recent.decidedAt?.getTime() ?? 0);
      if (
        typeof payload.dismissedAt === "string" ||
        now().getTime() - finishedAt > REPORT_KEEP_MS
      ) {
        const empty: BulkUpdateStatusResponse = {
          active: false,
          approvalId: null,
          runStatus: null,
          progress: null,
          reportMarkdown: null,
        };
        res.json(empty);
        return;
      }
    }
    const runStatus =
      runStatusRaw === "queued" ||
      runStatusRaw === "running" ||
      runStatusRaw === "completed" ||
      runStatusRaw === "failed"
        ? runStatusRaw
        : null;
    const progressParsed = BulkUpdateRunProgress.safeParse(payload.runProgress);
    const report =
      typeof payload.reportMarkdown === "string"
        ? payload.reportMarkdown
        : progressParsed.success
          ? progressParsed.data.reportMarkdown
          : null;
    const out: BulkUpdateStatusResponse = {
      active: runStatus === "queued" || runStatus === "running",
      approvalId: recent.id,
      runStatus,
      progress: progressParsed.success ? progressParsed.data : null,
      reportMarkdown: report,
    };
    res.json(out);
  });

  return router;
}

type BulkItem = {
  asset: SnapshotAsset;
  name: string;
  version: string;
  updateVersion: string;
};

function bulkItemKey(item: BulkItem): string {
  return `${item.asset}:${item.name}:${item.version}:${item.updateVersion}`;
}

/** True when every planned item was already in the prior approved set (same versions). */
function bulkItemsCoveredBy(planned: BulkItem[], prior: BulkItem[]): boolean {
  if (planned.length === 0 || prior.length === 0) return false;
  const priorKeys = new Set(prior.map(bulkItemKey));
  return planned.every((p) => priorKeys.has(bulkItemKey(p)));
}

/**
 * Block re-requesting production bulk for the same outdated set while a prior approval is
 * queued/running/completed successfully (A105). Failed runs may be re-requested.
 */
async function bulkUpdateBlockedByPriorApproval(
  db: Db,
  siteId: string,
  kind: string,
  planned: BulkItem[],
): Promise<boolean> {
  // PENDING is handled by requestApproval (already_pending). Here: same item set already
  // approved and not failed must not open a new approval loop.
  const recent = await db.approvalRequest.findMany({
    where: {
      action: "site.bulk_update",
      status: "APPROVED",
      AND: [
        { payload: { path: ["siteId"], equals: siteId } },
        { payload: { path: ["kind"], equals: kind } },
      ],
    },
    orderBy: { decidedAt: "desc" },
    take: 10,
  });
  for (const row of recent) {
    const payload = row.payload as {
      items?: BulkItem[];
      runStatus?: string;
    } | null;
    const prior = Array.isArray(payload?.items) ? payload.items : [];
    if (!bulkItemsCoveredBy(planned, prior)) continue;
    const runStatus = payload?.runStatus;
    // queued/running/completed/missing — block. failed — allow retry.
    if (runStatus === "failed") continue;
    return true;
  }
  return false;
}

/** Hub-wide Backups & snapshots list (spec screen 13). */
export function backupsRouter(deps: SnapshotDeps): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("sites.view", deps));

  router.get("/", async (_req, res) => {
    await purgeExpired(db, deps.snapshots, now());
    const rows = await db.backup.findMany({
      where: { status: { in: ["READY", "FAILED", "PENDING"] }, kind: "QUICK_SNAPSHOT" },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { site: { select: { name: true } }, environment: { select: { kind: true } } },
    });
    const wanted = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const users = wanted.length
      ? await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } })
      : [];
    const map = new Map(users.map((u) => [u.id, u]));
    const BackupStatus = z.enum(["PENDING", "READY", "FAILED", "EXPIRED"]);
    res.json({
      backups: rows.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        siteName: row.site.name,
        kind: "QUICK_SNAPSHOT" as const,
        status: BackupStatus.parse(row.status),
        environment: row.environment.kind,
        pluginName: row.pluginName,
        pluginVersion: row.pluginVersion,
        includesDb: row.includesDb,
        sizeBytes: row.sizeBytes,
        encrypted: row.encrypted,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        restoredAt: row.restoredAt?.toISOString() ?? null,
        createdBy: row.createdById ? (map.get(row.createdById) ?? null) : null,
      })),
    } satisfies z.infer<typeof BackupList>);
  });

  return router;
}
