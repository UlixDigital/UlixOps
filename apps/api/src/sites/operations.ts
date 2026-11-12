// Site detail (spec screen 5, Build Order step 6): inventory over WP-CLI, plugin activate /
// deactivate and emergency actions, each run by the runner and kept as a job log.
import { randomUUID } from "node:crypto";
import {
  type Command,
  EnvKind,
  InventoryItem,
  InventoryRefreshRequest,
  type InventoryView,
  RecordId,
  RemoteCommandResult,
  SITE_JOB_STALE_MS,
  type MaintenanceStatusResponse,
  SiteActionRequest,
  siteActionPermission,
  SiteInventoryResult,
  type SiteJobView,
  phpVersionCompare,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { raiseAlert } from "../alerts";
import { audit } from "../audit";
import type { Db } from "../db";
import {
  Prisma,
  type Site,
  type SiteEnvironment,
  type SiteInventory,
  type SiteJob,
} from "../generated/prisma/client";
import { authorize, clientIpOf, permitted, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { afterInventoryChange } from "../vulnerabilities/service";

export interface SiteOpsDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

/** How long the API waits for the runner (A49; raised for WP Engine update checks — A114). */
const INVENTORY_TIMEOUT_MS = 180_000;
const ACTION_TIMEOUT_MS = 45_000;
const MAX_OUTPUT = 20_000;

const Items = z.array(InventoryItem);
/** A stored inventory list, validated on read (malformed rows read as empty). */
export const items = (json: Prisma.JsonValue): InventoryItem[] => {
  const parsed = Items.safeParse(json);
  return parsed.success ? parsed.data : [];
};

/**
 * Fast refresh returns null updateVersion; keep prior update flags when the installed
 * version is unchanged so Update buttons don't disappear until Check for updates (A114).
 */
export function mergeInventoryUpdates(
  fresh: InventoryItem[],
  previous: InventoryItem[],
): InventoryItem[] {
  if (previous.length === 0) return fresh;
  const prev = new Map(previous.map((p) => [p.name, p]));
  return fresh.map((item) => {
    const old = prev.get(item.name);
    if (old && old.version === item.version && old.updateVersion) {
      return { ...item, updateVersion: old.updateVersion };
    }
    return item;
  });
}

/** The short form shown on the overview and the sites list. */
export function inventorySummary(inv: SiteInventory) {
  const plugins = items(inv.plugins);
  return {
    refreshedAt: inv.refreshedAt.toISOString(),
    activeTheme: inv.activeTheme,
    plugins: plugins.length,
    pluginUpdates: plugins.filter((p) => p.updateVersion !== null).length,
    themeUpdates: items(inv.themes).filter((t) => t.updateVersion !== null).length,
    maintenance: inv.maintenance,
    safeMode: inv.safeMode,
    coreUpdateVersion: inv.coreUpdateVersion,
    updatesCheckedAt: inv.updatesCheckedAt?.toISOString() ?? null,
  };
}

/**
 * Core-update fields to store with an inventory (A135): fresh after Check for updates; after a
 * fast refresh, keep the last check unless core has since reached that version.
 */
export function coreUpdateFields(
  result: { wpVersion: string; updatesChecked?: boolean; coreUpdateVersion?: string | null },
  previous: { coreUpdateVersion: string | null; updatesCheckedAt: Date | null } | null,
  at: Date,
): { coreUpdateVersion: string | null; updatesCheckedAt: Date | null } {
  if (result.updatesChecked)
    return { coreUpdateVersion: result.coreUpdateVersion ?? null, updatesCheckedAt: at };
  const kept =
    previous?.coreUpdateVersion &&
    phpVersionCompare(previous.coreUpdateVersion, result.wpVersion) > 0
      ? previous.coreUpdateVersion
      : null;
  return { coreUpdateVersion: kept, updatesCheckedAt: previous?.updatesCheckedAt ?? null };
}

/** Short human summary of a site job, for the Logs tab and the "working on" banner. */
export function jobSummary(action: string, params: Prisma.JsonValue): string {
  const p = (params ?? {}) as {
    plugin?: unknown;
    on?: unknown;
    emergency?: unknown;
    checkUpdates?: unknown;
    includeDb?: unknown;
    asset?: unknown;
    fromVersion?: unknown;
    toVersion?: unknown;
  };
  const plugin = typeof p.plugin === "string" ? p.plugin : "?";
  const asset = p.asset === "theme" ? "theme" : "plugin";
  const from = typeof p.fromVersion === "string" ? p.fromVersion : "?";
  const to = typeof p.toVersion === "string" ? p.toVersion : "?";
  switch (action) {
    case "inventory.refresh":
      return p.checkUpdates === true ? "Check for updates" : "Refresh inventory";
    case "plugin.activate":
      return `Activate ${plugin}`;
    case "plugin.deactivate":
      return `Deactivate ${plugin}${p.emergency === true ? " (emergency, plugins skipped)" : ""}`;
    case "maintenance":
      return p.on === true ? "Maintenance mode on" : "Maintenance mode off";
    case "cache.flush":
      return "Flush cache";
    case "snapshot.create":
      return `Snapshot ${asset} ${plugin}${p.includeDb === true ? " + database" : ""}`;
    case "snapshot.restore":
      return `Restore snapshot of ${plugin}`;
    case "plugin.update":
      return `Update plugin ${plugin}`;
    case "theme.update":
      return `Update theme ${plugin}`;
    case "plugin.delete":
      return `Delete plugin ${plugin}`;
    case "theme.delete":
      return `Delete theme ${plugin}`;
    case "core.update":
      return `Update WordPress ${from} → ${to}`;
    case "core.update-db":
      return `WordPress database upgrade${to !== "?" ? ` (${to})` : ""}`;
    case "core.rollback":
      return `Roll back WordPress ${from} → ${to}`;
    default:
      return action;
  }
}

/** The allowlisted command behind each action (packages/shared/src/commands.ts). */
function commandFor(action: SiteActionRequest): Command {
  switch (action.action) {
    case "plugin.activate":
      return { op: "plugin.activate", slug: action.plugin };
    case "plugin.deactivate":
      return { op: "plugin.deactivate", slug: action.plugin, safe: action.emergency };
    case "maintenance":
      return { op: "maintenance", on: action.on };
    case "cache.flush":
      return { op: "cache.flush" };
  }
}

const cap = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}… (truncated)` : text;

export function siteOpsRouter(deps: SiteOpsDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canRefresh = authorize("sites.refresh", deps);

  async function emails(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    const users = wanted.length
      ? await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } })
      : [];
    return new Map(users.map((u) => [u.id, u]));
  }

  function jobView(
    job: SiteJob & { environment: { kind: EnvKind } },
    users: Map<string, { id: string; email: string }>,
  ): SiteJobView {
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

  async function inventoryView(env: SiteEnvironment, inv: SiteInventory): Promise<InventoryView> {
    const users = await emails([inv.refreshedById]);
    return {
      kind: env.kind,
      refreshedAt: inv.refreshedAt.toISOString(),
      refreshedBy: inv.refreshedById ? (users.get(inv.refreshedById) ?? null) : null,
      wpVersion: inv.wpVersion,
      phpVersion: inv.phpVersion,
      wpCliVersion: inv.wpCliVersion,
      activeTheme: inv.activeTheme,
      maintenance: inv.maintenance,
      safeMode: inv.safeMode,
      warnings: inv.warnings,
      plugins: items(inv.plugins),
      themes: items(inv.themes),
      coreUpdateVersion: inv.coreUpdateVersion,
      updatesCheckedAt: inv.updatesCheckedAt?.toISOString() ?? null,
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

  /** Remote work needs a live site and a pinned host key (Test connection). */
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

  /**
   * Claims the environment for one job, atomically (agent decision A60): the lock row's primary
   * key lets only one concurrent insert win. A lock older than SITE_JOB_STALE_MS belongs to a
   * job the API never finished; one conditional update takes it over, so only one claimant can.
   * Returns the claim's token, or null when another job holds the environment.
   */
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

  /** Releases a claim; a no-op if a later claimant already took over a stale lock. */
  const release = (environmentId: string, token: string) =>
    db.siteEnvironmentLock.deleteMany({ where: { environmentId, token } });

  /**
   * Runs one job on the runner and records it: a job row (the job log), an audit row and,
   * for a changed host key, a security alert. Runner failures become a FAILED job, not a 5xx,
   * so the user always sees what happened. Answers null, running nothing, while another job
   * holds the environment.
   */
  async function runJob<R>(...args: Parameters<typeof runClaimed<R>>) {
    const env = args[2];
    const token = await claim(env.id);
    if (!token) return null;
    try {
      return await runClaimed(...args);
    } finally {
      await release(env.id, token);
    }
  }

  async function runClaimed<R>(
    req: Request,
    site: Site,
    env: SiteEnvironment & { hostKey: string },
    action: string,
    params: Prisma.InputJsonObject,
    call: () => Promise<unknown>,
    parse: (raw: unknown) => R & ({ hostKeyMismatch: true } | { hostKeyMismatch: false }),
    finish: (result: R & { hostKeyMismatch: false }) => Promise<{
      ok: boolean;
      exitCode: number | null;
      output: string;
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
      const result = parse(await call());
      if (result.hostKeyMismatch) {
        hostKeyMismatch = true;
        outcome = {
          ok: false,
          exitCode: null,
          output:
            "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted. Check with the host before resetting the key.",
          error: "host_key_mismatch",
        };
      } else {
        outcome = await finish(result as R & { hostKeyMismatch: false });
      }
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
        // Already redacted by the runner.
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

  router.get("/:id/environments/:kind/inventory", canView, async (req, res) => {
    const found = await load(req, res);
    if (!found) return;
    const inv = await db.siteInventory.findUnique({ where: { environmentId: found.env.id } });
    res.json({ inventory: inv ? await inventoryView(found.env, inv) : null });
  });

  /**
   * Live maintenance check for Emergency: WP-CLI is-active plus leftover `.maintenance`
   * from a stuck update (A111). Falls back to the last inventory when SSH is unavailable.
   */
  router.get("/:id/environments/:kind/maintenance", canView, async (req, res) => {
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    const inv = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    const fallback = (): MaintenanceStatusResponse => ({
      on: inv?.maintenance === true,
      source: "inventory",
      detail:
        inv?.maintenance === true
          ? "Last inventory reported maintenance on"
          : inv?.maintenance === false
            ? "Last inventory reported maintenance off (may be stale)"
            : "No inventory yet",
    });
    if (site.archived || !env.hostKey) {
      res.json(fallback());
      return;
    }
    try {
      // Short timeout: Emergency must not wait a full action window for a status badge (A113).
      const raw = await deps.runner.run(
        {
          type: "remote.command",
          target: {
            host: env.sshHost,
            port: env.sshPort,
            user: env.sshUser,
            wpPath: env.wpPath,
            credentialRef: env.credentialRef,
            hostKey: env.hostKey,
          },
          command: { op: "maintenance.status" },
        },
        20_000,
      );
      const out = RemoteCommandResult.parse(raw);
      if (out.hostKeyMismatch) {
        res.json(fallback());
        return;
      }
      const on = out.exitCode === 0;
      if (inv && inv.maintenance !== on) {
        await db.siteInventory.update({
          where: { id: inv.id },
          data: { maintenance: on },
        });
      }
      const body: MaintenanceStatusResponse = {
        on,
        source: "live",
        detail: on
          ? out.stdout.trim() || "Maintenance is on (WP-CLI or .maintenance file)"
          : "Maintenance is off",
      };
      res.json(body);
    } catch {
      res.json(fallback());
    }
  });

  router.post("/:id/environments/:kind/inventory", canRefresh, async (req, res) => {
    const body = InventoryRefreshRequest.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const checkUpdates = body.data.checkUpdates === true;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;
    const previous = await db.siteInventory.findUnique({ where: { environmentId: env.id } });
    let stored: SiteInventory | null = null;
    const ran = await runJob(
      req,
      site,
      env,
      "inventory.refresh",
      { checkUpdates },
      () =>
        deps.runner.run(
          { type: "site.inventory", target: targetOf(env), checkUpdates },
          INVENTORY_TIMEOUT_MS,
        ),
      (raw) => SiteInventoryResult.parse(raw),
      async (result) => {
        const plugins = checkUpdates
          ? result.plugins
          : mergeInventoryUpdates(result.plugins, previous ? items(previous.plugins) : []);
        const themes = checkUpdates
          ? result.themes
          : mergeInventoryUpdates(result.themes, previous ? items(previous.themes) : []);
        const data = {
          refreshedAt: now(),
          refreshedById: sessionOf(req).user.id,
          wpVersion: result.wpVersion,
          phpVersion: result.phpVersion,
          wpCliVersion: result.wpCliVersion,
          activeTheme: themes.find((t) => t.status === "active")?.name ?? null,
          maintenance: result.maintenance,
          safeMode: result.safeMode,
          warnings: result.warnings,
          plugins,
          themes,
          ...coreUpdateFields(result, previous, now()),
        };
        stored = await db.siteInventory.upsert({
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
        const updates = plugins.filter((p) => p.updateVersion !== null).length;
        const lines = [
          checkUpdates
            ? "Checked for plugin and theme updates."
            : "Fast inventory (no update check).",
          `WordPress ${result.wpVersion} · PHP ${result.phpVersion} · WP-CLI ${result.wpCliVersion}`,
          `${plugins.length} plugins (${updates} with updates), ${themes.length} themes`,
          `Maintenance mode: ${result.maintenance === null ? "unknown" : result.maintenance ? "on" : "off"}`,
          ...(result.safeMode
            ? ["Read with plugins and themes skipped: a plugin may be crashing the site."]
            : []),
          ...result.warnings,
        ];
        return { ok: true, exitCode: 0, output: lines.join("\n") };
      },
    );
    if (!ran) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    const inventory: SiteInventory | null = stored;
    res.json({
      ...ran,
      inventory: inventory ? await inventoryView(env, inventory) : null,
    });
  });

  router.post("/:id/environments/:kind/actions", async (req, res) => {
    const body = SiteActionRequest.safeParse(req.body);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    if (!body.success || !kind.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await permitted(req, res, siteActionPermission(body.data.action, kind.data), deps)))
      return;
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!(await ready(res, site, env)) || !pinned(env)) return;

    const action = body.data;
    const { action: name, ...params } = action;
    const result = await runJob(
      req,
      site,
      env,
      name,
      params,
      () =>
        deps.runner.run(
          { type: "remote.command", target: targetOf(env), command: commandFor(action) },
          ACTION_TIMEOUT_MS,
        ),
      (raw) => RemoteCommandResult.parse(raw),
      async (out) => {
        const ok = out.exitCode === 0;
        if (ok) await applyToInventory(env.id, action);
        return {
          ok,
          exitCode: out.exitCode,
          output: [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n"),
        };
      },
    );
    if (!result) {
      res.status(409).json({ error: "site_busy" });
      return;
    }
    res.json(result);
  });

  /** Keeps the stored inventory in step with an action that succeeded (no extra SSH calls). */
  async function applyToInventory(environmentId: string, action: SiteActionRequest) {
    const inv = await db.siteInventory.findUnique({ where: { environmentId } });
    if (!inv) return;
    if (action.action === "maintenance") {
      await db.siteInventory.update({ where: { id: inv.id }, data: { maintenance: action.on } });
      return;
    }
    if (action.action === "cache.flush") return;
    const status = action.action === "plugin.activate" ? "active" : "inactive";
    const plugins = items(inv.plugins).map((p) =>
      p.name === action.plugin && (p.status === "active" || p.status === "inactive")
        ? { ...p, status }
        : p,
    );
    await db.siteInventory.update({ where: { id: inv.id }, data: { plugins } });
  }

  router.get("/:id/jobs", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(req.query.limit);
    if (!id.success || !limit.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!(await db.site.findUnique({ where: { id: id.data }, select: { id: true } }))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const jobs = await db.siteJob.findMany({
      where: { siteId: id.data },
      orderBy: { startedAt: "desc" },
      take: limit.data,
      include: { environment: { select: { kind: true } } },
    });
    const users = await emails(jobs.map((j) => j.requestedById));
    res.json({ jobs: jobs.map((job) => jobView(job, users)) });
  });

  return router;
}
