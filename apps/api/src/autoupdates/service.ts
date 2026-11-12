// Scheduled updates (Phase 4 step 2, A162). In each site's weekly window (hourly tick), patch
// and minor plugin / theme updates and WordPress maintenance releases install unattended:
// staging first when it is connected, then production with only the versions staging is now
// running. Every item: quick snapshot → update → health check → rollback on failure; the first
// problem stops the run, and a rolled-back version is held until a newer one is offered.
// Switching on always goes through an ApprovalRequest (`site.autoupdate.enable`).
import { randomUUID } from "node:crypto";
import {
  type AutoUpdateCandidate,
  type AutoUpdateEnvReport,
  type AutoUpdateHold,
  AutoUpdateHoldList,
  type AutoUpdateItemReport,
  type AutoUpdateOverviewRow,
  AutoUpdateRunStatus,
  type AutoUpdateRunView,
  type AutoUpdateSettingsRequest,
  AutoUpdateSkipList,
  AUTOUPDATE_SKIP_LABELS,
  type AutoUpdateView,
  type AutoUpdateWindow,
  autoUpdateDue,
  autoUpdateWindowStart,
  AutoUpdateEnvReport as EnvReportSchema,
  AutoUpdateItemReport as ItemReportSchema,
  CoreVersion,
  DEFAULT_AUTOUPDATE_WINDOW,
  nextAutoUpdateWindow,
  planAutoUpdates,
  pruneHolds,
  RemoteCommandResult,
  type RoleName,
  SITE_JOB_STALE_MS,
  verifiedVersions,
} from "@ulixops/shared";
import { z } from "zod";
import { requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { audit } from "../audit";
import type { Db } from "../db";
import { loadEnv } from "../env";
import type {
  AutoUpdateRun,
  AutoUpdateSchedule,
  Prisma,
  Site,
  SiteEnvironment,
} from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import { items } from "../sites/operations";
import type { VisualStore } from "../visual/store";
import {
  type EnvPinned,
  executeBulkUpdateRun,
  refreshInventory,
  runHealth,
  targetOf,
  UPDATE_TIMEOUT_MS,
} from "../snapshots/bulk-update-run";

export interface AutoUpdateDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
  /** Snapshot retention when Settings has none; defaults to SNAPSHOT_RETENTION_DAYS. */
  defaultRetentionDays?: number;
  /** Before/after screenshots around the run (A163). */
  visualStore?: VisualStore;
}

type RunDeps = AutoUpdateDeps & { defaultRetentionDays: number };
type Actor = { userId: string | null; ip: string | null };
type SiteWithEnvs = Site & { environments: SiteEnvironment[] };

const RUNS_SHOWN = 10;
const RUNS_KEPT = 52;

const pinned = (env: SiteEnvironment | undefined): env is EnvPinned => Boolean(env?.hostKey);
const envOf = (site: SiteWithEnvs, kind: "PRODUCTION" | "STAGING") =>
  site.environments.find((e) => e.kind === kind);

export function skipOf(row: Pick<AutoUpdateSchedule, "skip"> | null) {
  const parsed = AutoUpdateSkipList.safeParse(row?.skip ?? []);
  return parsed.success ? parsed.data : [];
}
export function holdsOf(row: Pick<AutoUpdateSchedule, "holds"> | null) {
  const parsed = AutoUpdateHoldList.safeParse(row?.holds ?? []);
  return parsed.success ? parsed.data : [];
}
const windowOf = (row: AutoUpdateSchedule | null): AutoUpdateWindow =>
  row ? { dayOfWeek: row.dayOfWeek, hourUtc: row.hourUtc } : DEFAULT_AUTOUPDATE_WINDOW;

const RunReport = z.object({
  environments: z.array(EnvReportSchema).default([]),
  manual: z.array(ItemReportSchema).default([]),
});

export function runView(row: AutoUpdateRun): AutoUpdateRunView {
  const report = RunReport.safeParse(row.report);
  const status = AutoUpdateRunStatus.safeParse(row.status);
  return {
    id: row.id,
    windowAt: row.windowAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: status.success ? status.data : "interrupted",
    environments: report.success ? report.data.environments : [],
    manual: report.success ? report.data.manual : [],
    updated: row.updated,
    problems: row.problems,
  };
}

// ---- Views ---------------------------------------------------------------------------------

/** Pending `site.autoupdate.enable` requests that include this site. */
async function pendingFor(db: Db, siteId: string) {
  return db.approvalRequest.findFirst({
    where: {
      action: "site.autoupdate.enable",
      status: "PENDING",
      payload: { path: ["siteIds"], array_contains: [siteId] },
    },
    select: { id: true },
  });
}

export async function autoUpdateView(
  deps: Pick<AutoUpdateDeps, "db" | "now">,
  site: SiteWithEnvs,
): Promise<AutoUpdateView> {
  const { db } = deps;
  const [row, runs, pending] = await Promise.all([
    db.autoUpdateSchedule.findUnique({ where: { siteId: site.id } }),
    db.autoUpdateRun.findMany({
      where: { siteId: site.id },
      orderBy: { startedAt: "desc" },
      take: RUNS_SHOWN,
    }),
    pendingFor(db, site.id),
  ]);
  const window = windowOf(row);
  return {
    siteId: site.id,
    enabled: row?.enabled ?? false,
    window,
    skip: skipOf(row),
    holds: holdsOf(row),
    pendingApprovalId: pending?.id ?? null,
    nextWindowAt: row?.enabled ? nextWindowAt(row, deps.now()).toISOString() : null,
    hasStaging: Boolean(envOf(site, "STAGING")),
    enabledAt: row?.enabled ? (row.enabledAt?.toISOString() ?? null) : null,
    runs: runs.map(runView),
  };
}

/** The coming window: this week's when it hasn't run yet and is still open, else next week's. */
function nextWindowAt(row: AutoUpdateSchedule, now: Date): Date {
  const w = windowOf(row);
  if (autoUpdateDue({ ...w, enabled: true, lastWindowAt: row.lastWindowAt }, now))
    return autoUpdateWindowStart(w, now);
  return nextAutoUpdateWindow(w, now);
}

export async function autoUpdateOverview(
  deps: Pick<AutoUpdateDeps, "db" | "now">,
): Promise<AutoUpdateOverviewRow[]> {
  const { db } = deps;
  const [sites, pending] = await Promise.all([
    db.site.findMany({
      where: { archived: false },
      include: {
        environments: { select: { kind: true } },
        autoUpdate: true,
        autoUpdateRuns: { orderBy: { startedAt: "desc" }, take: 1 },
      },
      orderBy: { name: "asc" },
    }),
    db.approvalRequest.findMany({
      where: { action: "site.autoupdate.enable", status: "PENDING" },
      select: { payload: true },
    }),
  ]);
  const waiting = new Set(
    pending.flatMap((p) => {
      const ids = (p.payload as { siteIds?: unknown } | null)?.siteIds;
      return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
    }),
  );
  return sites.map((s) => {
    const row = s.autoUpdate;
    const last = s.autoUpdateRuns[0];
    return {
      siteId: s.id,
      siteName: s.name,
      enabled: row?.enabled ?? false,
      window: row ? windowOf(row) : null,
      pendingApproval: waiting.has(s.id),
      nextWindowAt: row?.enabled ? nextWindowAt(row, deps.now()).toISOString() : null,
      hasStaging: s.environments.some((e) => e.kind === "STAGING"),
      lastRun: last
        ? (({ startedAt, status, updated, problems }) => ({
            startedAt,
            status,
            updated,
            problems,
          }))(runView(last))
        : null,
      holds: holdsOf(row).length,
    };
  });
}

// ---- Settings (Admin, audited) -------------------------------------------------------------

export async function saveSettings(
  deps: Pick<AutoUpdateDeps, "db" | "now">,
  siteId: string,
  body: AutoUpdateSettingsRequest,
  actor: Actor,
): Promise<void> {
  const data = {
    dayOfWeek: body.dayOfWeek,
    hourUtc: body.hourUtc,
    skip: body.skip as Prisma.InputJsonArray,
    updatedById: actor.userId,
  };
  const before = await deps.db.autoUpdateSchedule.findUnique({ where: { siteId } });
  await deps.db.autoUpdateSchedule.upsert({
    where: { siteId },
    create: { siteId, ...data },
    update: data,
  });
  await audit(
    deps.db,
    {
      userId: actor.userId,
      action: "site.autoupdate.settings",
      result: "success",
      ip: actor.ip,
      siteIds: [siteId],
      meta: {
        dayOfWeek: body.dayOfWeek,
        hourUtc: body.hourUtc,
        skip: body.skip.map((s) => `${s.asset}:${s.name}`).slice(0, 50),
        enabled: before?.enabled ?? false,
      },
    },
    deps.now(),
  );
}

/** Switching off makes things safer, so an Admin does it alone. */
export async function disable(
  deps: Pick<AutoUpdateDeps, "db" | "now">,
  siteId: string,
  actor: Actor,
): Promise<boolean> {
  const changed = await deps.db.autoUpdateSchedule.updateMany({
    where: { siteId, enabled: true },
    data: { enabled: false, updatedById: actor.userId },
  });
  if (changed.count === 0) return false;
  await audit(
    deps.db,
    {
      userId: actor.userId,
      action: "site.autoupdate.disable",
      result: "success",
      ip: actor.ip,
      siteIds: [siteId],
    },
    deps.now(),
  );
  return true;
}

export async function clearHold(
  deps: Pick<AutoUpdateDeps, "db" | "now">,
  siteId: string,
  target: { asset: string; name: string },
  actor: Actor,
): Promise<boolean> {
  const row = await deps.db.autoUpdateSchedule.findUnique({ where: { siteId } });
  const holds = holdsOf(row);
  const kept = holds.filter((h) => !(h.asset === target.asset && h.name === target.name));
  if (!row || kept.length === holds.length) return false;
  await deps.db.autoUpdateSchedule.update({
    where: { siteId },
    data: { holds: kept as Prisma.InputJsonArray, updatedById: actor.userId },
  });
  await audit(
    deps.db,
    {
      userId: actor.userId,
      action: "site.autoupdate.hold_clear",
      result: "success",
      ip: actor.ip,
      siteIds: [siteId],
      meta: { asset: target.asset, name: target.name },
    },
    deps.now(),
  );
  return true;
}

/**
 * Switching on approves unattended production updates in advance, so it always needs a second
 * Admin (or a Super Admin's self-approval, A134), for one site as for many.
 */
export async function requestEnable(
  deps: AutoUpdateDeps,
  siteIds: string[],
  fallback: AutoUpdateWindow | undefined,
  user: { id: string; role: RoleName },
  ip: string | null,
): Promise<
  | { ok: true; requestId: string; selfApproved: boolean; count: number }
  | { ok: false; error: "not_found" | "already_enabled" | "already_pending" }
> {
  const { db } = deps;
  const sites = await db.site.findMany({
    where: {
      id: { in: siteIds },
      archived: false,
      environments: { some: { kind: "PRODUCTION", hostKey: { not: null } } },
    },
    include: { autoUpdate: true },
    orderBy: { name: "asc" },
  });
  if (sites.length === 0) return { ok: false, error: "not_found" };
  const off = sites.filter((s) => !s.autoUpdate?.enabled);
  if (off.length === 0) return { ok: false, error: "already_enabled" };
  const single = off.length === 1 ? off[0] : undefined;
  const asked = await requestApproval(
    db,
    {
      action: "site.autoupdate.enable",
      payload: {
        // One pending request per site, or one bulk request at a time.
        siteId: single?.id ?? "",
        kind: single ? "autoupdate" : "bulk",
        siteIds: off.map((s) => s.id),
        siteNames: off.map((s) => s.name),
        sites: off.map((s) => ({
          siteId: s.id,
          ...(s.autoUpdate ? windowOf(s.autoUpdate) : (fallback ?? DEFAULT_AUTOUPDATE_WINDOW)),
        })),
      },
      requestedById: user.id,
      ip,
      requesterRole: user.role,
    },
    deps.now(),
    deps.notifier,
  );
  if (!asked.ok) return asked;
  const selfApproved = await selfApproveIfAllowed(
    { db, now: deps.now, notifier: deps.notifier },
    asked.id,
    user,
    ip,
  );
  return { ok: true, requestId: asked.id, selfApproved, count: off.length };
}

// ---- The scheduled run ---------------------------------------------------------------------

let active: Promise<void> | null = null;
/** True while a scheduled run is going (one process, one run at a time). */
export const isAutoUpdating = () => active !== null;
/** The current background run, for tests. */
export const currentAutoUpdates = () => active ?? Promise.resolve();

/** Hourly tick: start every site whose window is open, one site after another. */
export function startDueAutoUpdates(deps: AutoUpdateDeps): Promise<void> {
  if (active) return active;
  const run = runDue({
    ...deps,
    defaultRetentionDays: deps.defaultRetentionDays ?? loadEnv().SNAPSHOT_RETENTION_DAYS,
  }).finally(() => {
    active = null;
  });
  active = run;
  return run;
}

async function runDue(deps: RunDeps): Promise<void> {
  const { db } = deps;
  // Nothing runs in this process yet, so a "running" row was cut off by an API restart.
  const cut = await db.autoUpdateRun.findMany({
    where: { status: "running" },
    include: { site: { select: { name: true } } },
  });
  for (const row of cut) {
    await db.autoUpdateRun.update({
      where: { id: row.id },
      data: { status: "interrupted", finishedAt: deps.now() },
    });
    await deps.notifier.notify?.({
      kind: "autoupdate.problems",
      title: `Scheduled updates interrupted on ${row.site.name}`,
      body: "The hub restarted during the run. Check the site's Plugins & themes page; anything not finished will be tried in the next window.",
      severity: "warning",
      siteIds: [row.siteId],
    });
  }

  const schedules = await db.autoUpdateSchedule.findMany({
    where: { enabled: true, site: { archived: false } },
    include: { site: { include: { environments: true } } },
  });
  for (const s of schedules) {
    if (
      !autoUpdateDue(
        { ...windowOf(s), enabled: s.enabled, lastWindowAt: s.lastWindowAt },
        deps.now(),
      )
    )
      continue;
    try {
      await runSite(deps, s, s.site);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "autoupdate_site_failed",
          siteId: s.siteId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/** Claim every environment the run touches; null (nothing held) when one is busy. */
async function claimAll(deps: AutoUpdateDeps, envIds: string[]) {
  const held: { environmentId: string; token: string }[] = [];
  for (const environmentId of envIds) {
    const token = randomUUID();
    try {
      await deps.db.siteEnvironmentLock.create({
        data: { environmentId, token, lockedAt: deps.now() },
      });
      held.push({ environmentId, token });
    } catch {
      // A lock left by a stopped job is taken over after SITE_JOB_STALE_MS (A60).
      const taken = await deps.db.siteEnvironmentLock.updateMany({
        where: {
          environmentId,
          lockedAt: { lt: new Date(deps.now().getTime() - SITE_JOB_STALE_MS) },
        },
        data: { token, lockedAt: deps.now() },
      });
      if (taken.count !== 1) {
        await releaseAll(deps, held);
        return null;
      }
      held.push({ environmentId, token });
    }
  }
  return held;
}

async function releaseAll(deps: AutoUpdateDeps, held: { environmentId: string; token: string }[]) {
  for (const h of held) await deps.db.siteEnvironmentLock.deleteMany({ where: h });
}

export async function runSite(
  deps: RunDeps,
  schedule: AutoUpdateSchedule,
  site: SiteWithEnvs,
): Promise<AutoUpdateRun | null> {
  const { db } = deps;
  const windowAt = autoUpdateWindowStart(windowOf(schedule), deps.now());
  const production = envOf(site, "PRODUCTION");
  const stagingEnv = envOf(site, "STAGING");
  const staging = pinned(stagingEnv) ? stagingEnv : undefined;

  const envs = [staging, pinned(production) ? production : undefined].filter((e): e is EnvPinned =>
    Boolean(e),
  );
  const held = pinned(production)
    ? await claimAll(
        deps,
        envs.map((e) => e.id),
      )
    : [];
  // Busy (a backup, scan or restore is running): try again next hour, inside the grace period.
  if (held === null) return null;

  // Keep the locks fresh so a long run is never taken over as stale (A60/A110).
  const heartbeat = setInterval(() => {
    void Promise.all(
      held.map((h) =>
        db.siteEnvironmentLock.updateMany({ where: h, data: { lockedAt: deps.now() } }),
      ),
    ).catch(() => undefined);
  }, 60_000);
  heartbeat.unref();

  await db.autoUpdateSchedule.update({
    where: { siteId: site.id },
    data: { lastWindowAt: windowAt },
  });
  const run = await db.autoUpdateRun.create({
    data: { siteId: site.id, windowAt, startedAt: deps.now(), status: "running" },
  });

  const skip = skipOf(schedule);
  let holds = holdsOf(schedule);
  const offered: AutoUpdateCandidate[] = [];
  const environments: AutoUpdateEnvReport[] = [];
  let manual: AutoUpdateItemReport[] = [];
  let problems = 0;
  try {
    if (!pinned(production)) {
      problems += 1;
      environments.push({
        kind: "PRODUCTION",
        ran: false,
        detail: "Not updated: the production connection isn't tested (no pinned host key).",
        items: [],
      });
    } else {
      let verified: Set<string> | null = null;
      let stagingFailed = false;
      if (staging) {
        const r = await runEnvironment(deps, site, staging, { skip, holds, verified: null });
        environments.push(r.report);
        offered.push(...r.offered);
        holds = mergeHolds(holds, r.newHolds);
        problems += r.problems;
        stagingFailed = r.problems > 0;
        if (!stagingFailed) {
          const inv = await db.siteInventory.findUnique({ where: { environmentId: staging.id } });
          verified = verifiedVersions({
            plugins: items(inv?.plugins ?? []),
            themes: items(inv?.themes ?? []),
            wpVersion: inv?.wpVersion ?? null,
          });
        }
      }
      const r = await runEnvironment(deps, site, production, {
        skip,
        holds,
        verified,
        stagingFailed,
      });
      environments.push(r.report);
      offered.push(...r.offered);
      holds = mergeHolds(holds, r.newHolds);
      problems += r.problems;
      manual = r.manual;
    }
  } catch (error) {
    problems += 1;
    environments.push({
      kind: "PRODUCTION",
      ran: false,
      detail: `The run stopped: ${error instanceof Error ? error.message.slice(0, 500) : "unexpected error"}`,
      items: [],
    });
  } finally {
    clearInterval(heartbeat);
    await releaseAll(deps, held);
  }

  // A hold lasts while that exact version is still offered somewhere (A162).
  holds = pruneHolds(holds, offered);
  await db.autoUpdateSchedule.update({
    where: { siteId: site.id },
    data: { holds: holds as Prisma.InputJsonArray },
  });

  const all = environments.flatMap((e) => e.items);
  const updated = all.filter((i) => i.outcome === "updated").length;
  const status = problems > 0 ? "problems" : updated > 0 ? "completed" : "nothing_to_do";
  const finished = await db.autoUpdateRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: deps.now(),
      updated,
      problems,
      report: { environments, manual } as unknown as Prisma.InputJsonObject,
    },
  });
  // Keep a year of weekly runs per site.
  const old = await db.autoUpdateRun.findMany({
    where: { siteId: site.id },
    orderBy: { startedAt: "desc" },
    skip: RUNS_KEPT,
    select: { id: true },
  });
  if (old.length)
    await db.autoUpdateRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

  await audit(
    db,
    {
      userId: null,
      action: "site.autoupdate.run",
      result: problems > 0 ? "failure" : "success",
      ip: null,
      siteIds: [site.id],
      meta: { runId: run.id, status, updated, problems },
    },
    deps.now(),
  );
  await alert(deps, site, environments, manual, { updated, problems });
  return finished;
}

/** Holds are per site: one per item and version. */
function mergeHolds(holds: AutoUpdateHold[], add: AutoUpdateHold[]): AutoUpdateHold[] {
  const out = [...holds];
  for (const h of add)
    if (!out.some((o) => o.asset === h.asset && o.name === h.name && o.version === h.version))
      out.push(h);
  return out;
}

const itemReport = (
  c: AutoUpdateCandidate,
  outcome: AutoUpdateItemReport["outcome"],
  detail: string,
): AutoUpdateItemReport => ({
  asset: c.asset,
  name: c.name,
  version: c.version,
  updateVersion: c.updateVersion,
  safety: c.safety,
  outcome,
  detail: detail.slice(0, 2000),
});

async function runEnvironment(
  deps: RunDeps,
  site: Site,
  env: EnvPinned,
  opts: {
    skip: ReturnType<typeof skipOf>;
    holds: AutoUpdateHold[];
    verified: Set<string> | null;
    stagingFailed?: boolean;
  },
): Promise<{
  report: AutoUpdateEnvReport;
  offered: AutoUpdateCandidate[];
  manual: AutoUpdateItemReport[];
  newHolds: AutoUpdateHold[];
  problems: number;
}> {
  const kind = env.kind;
  const fail = (detail: string) => ({
    report: { kind, ran: false, detail, items: [] },
    offered: [],
    manual: [],
    newHolds: [],
    problems: 1,
  });
  try {
    if (!(await refreshInventory(deps, env, null)))
      return fail("Not updated: the SSH host key no longer matches the pinned one.");
  } catch (error) {
    return fail(
      `Not updated: couldn't read the plugins and available updates (${error instanceof Error ? error.message.slice(0, 300) : "error"}).`,
    );
  }
  const inv = await deps.db.siteInventory.findUnique({ where: { environmentId: env.id } });
  const plan = planAutoUpdates(
    {
      plugins: items(inv?.plugins ?? []),
      themes: items(inv?.themes ?? []),
      wpVersion: inv?.wpVersion ?? null,
      coreUpdateVersion: inv?.coreUpdateVersion ?? null,
    },
    { skip: opts.skip, holds: opts.holds, verified: opts.verified },
  );
  const offered = [...plan.auto, ...plan.skipped, ...plan.manual];
  const manual = plan.manual.map((c) =>
    itemReport(
      c,
      "skipped",
      c.asset === "core"
        ? "New WordPress release: update by hand"
        : "Major version: update by hand",
    ),
  );
  const reports: AutoUpdateItemReport[] = plan.skipped.map((c) =>
    itemReport(c, "skipped", AUTOUPDATE_SKIP_LABELS[c.reason]),
  );
  const done = (
    ran: boolean,
    detail: string,
    problems: number,
    newHolds: AutoUpdateHold[] = [],
  ) => ({
    report: { kind, ran, detail, items: reports },
    offered,
    manual,
    newHolds,
    problems,
  });

  if (opts.stagingFailed) {
    reports.push(
      ...plan.auto.map((c) => itemReport(c, "skipped", AUTOUPDATE_SKIP_LABELS.staging_failed)),
    );
    return done(false, "Not updated: staging had problems, so production was left alone.", 0);
  }
  if (plan.auto.length === 0) return done(true, "Nothing to update automatically.", 0);

  const newHolds: AutoUpdateHold[] = [];
  const hold = (c: AutoUpdateCandidate, reason: string) =>
    newHolds.push({
      asset: c.asset,
      name: c.name,
      version: c.updateVersion,
      at: deps.now().toISOString(),
      reason: reason.slice(0, 500),
    });
  let problems = 0;
  let healthyStart = true;

  const assets = plan.auto.filter((c) => c.asset !== "core");
  const core = plan.auto.find((c) => c.asset === "core");
  if (assets.length > 0) {
    const { progress } = await executeBulkUpdateRun(deps, {
      site,
      env,
      items: assets.map((c) => ({
        asset: c.asset === "theme" ? "theme" : "plugin",
        name: c.name,
        version: c.version,
        updateVersion: c.updateVersion,
        safety: c.safety,
      })),
      actorUserId: null,
      onProgress: async () => undefined,
      stopOnFailure: true,
      requireHealthyStart: true,
    });
    healthyStart = progress.preHealth?.ok ?? false;
    progress.items.forEach((p, i) => {
      const c = assets[i];
      if (!c) return;
      const last = p.steps.at(-1)?.detail ?? "";
      if (p.outcome === "succeeded") {
        reports.push(
          itemReport(c, "updated", `Updated ${c.version} → ${c.updateVersion}; health OK`),
        );
      } else if (p.outcome === "rolled_back" || p.outcome === "failed") {
        problems += 1;
        reports.push(itemReport(c, p.outcome, last));
        // Snapshot failures are passing trouble; an update that failed or broke the site is held.
        if (p.steps.some((s) => s.step === "update")) hold(c, last);
      } else {
        reports.push(
          itemReport(
            c,
            "not_run",
            healthyStart
              ? "Not run: the run stopped after a problem"
              : "Not run: the site was unhealthy before updating",
          ),
        );
      }
    });
  } else {
    try {
      healthyStart = (await runHealth(deps, env)).ok;
    } catch {
      healthyStart = false;
    }
  }

  if (core) {
    if (!healthyStart || problems > 0) {
      reports.push(
        itemReport(
          core,
          "not_run",
          healthyStart
            ? "Not run: the run stopped after a problem"
            : "Not run: the site was unhealthy before updating",
        ),
      );
    } else {
      const r = await updateCore(deps, env, core.version, core.updateVersion);
      reports.push(itemReport(core, r.outcome, r.detail));
      if (r.outcome !== "updated") {
        problems += 1;
        hold(core, r.detail);
      }
      try {
        await refreshInventory(deps, env, null);
      } catch {
        // best-effort; the next reading catches up
      }
    }
  }
  if (!healthyStart)
    return done(
      false,
      "Not updated: the site failed its health check before updating.",
      problems + 1,
    );
  return done(true, problems ? "Stopped after a problem." : "Updated.", problems, newHolds);
}

/**
 * WordPress maintenance release, as the manual core update does it (A135): update → database
 * upgrade → health; if unhealthy, re-install the previous release and check again.
 */
async function updateCore(
  deps: AutoUpdateDeps,
  env: EnvPinned,
  fromVersion: string,
  toVersion: string,
): Promise<{ outcome: "updated" | "rolled_back" | "failed"; detail: string }> {
  const run = async (
    command: { op: "core.update"; version: string; force?: boolean } | { op: "core.update-db" },
  ) => {
    try {
      const raw = await deps.runner.run(
        { type: "remote.command", target: targetOf(env), command },
        UPDATE_TIMEOUT_MS,
      );
      const out = RemoteCommandResult.parse(raw);
      if (out.hostKeyMismatch) return { ok: false, output: "SSH host key mismatch" };
      return {
        ok: out.exitCode === 0,
        output: [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n"),
      };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : "failed" };
    }
  };
  const health = async () => {
    try {
      return await runHealth(deps, env);
    } catch {
      return { ok: false, summary: "The health check could not run." };
    }
  };
  const updated = await run({ op: "core.update", version: toVersion });
  if (!updated.ok)
    return {
      outcome: "failed",
      detail: `WP-CLI could not update WordPress; nothing was changed. ${updated.output}`.trim(),
    };
  await run({ op: "core.update-db" });
  const after = await health();
  if (after.ok) return { outcome: "updated", detail: `Healthy on WordPress ${toVersion}.` };
  if (!CoreVersion.safeParse(fromVersion).success)
    return {
      outcome: "failed",
      detail: `Health check failed (${after.summary}) and ${fromVersion} can't be re-installed automatically. Check the site now.`,
    };
  const restored = await run({ op: "core.update", version: fromVersion, force: true });
  const again = restored.ok ? await health() : { ok: false, summary: "rollback failed" };
  return restored.ok && again.ok
    ? {
        outcome: "rolled_back",
        detail: `Health check failed on ${toVersion} (${after.summary}); WordPress ${fromVersion} was re-installed and the site is healthy again.`,
      }
    : {
        outcome: "failed",
        detail: `Health check failed on ${toVersion} (${after.summary}) and the rollback to ${fromVersion} did not bring it back (${again.summary}). Check the site now.`,
      };
}

async function alert(
  deps: AutoUpdateDeps,
  site: Site,
  environments: AutoUpdateEnvReport[],
  manual: AutoUpdateItemReport[],
  counts: { updated: number; problems: number },
) {
  // A quiet week (nothing installed, nothing wrong) is in the run history, not an alert.
  if (counts.updated === 0 && counts.problems === 0) return;
  const lines: string[] = [];
  for (const env of environments) {
    lines.push(`${env.kind === "STAGING" ? "Staging" : "Production"}: ${env.detail}`);
    for (const i of env.items) {
      if (i.outcome === "skipped" && i.detail === AUTOUPDATE_SKIP_LABELS.skip_list) continue;
      lines.push(`- ${i.name} ${i.version} → ${i.updateVersion}: ${i.outcome.replace("_", " ")}`);
    }
  }
  if (manual.length)
    lines.push(
      `Waiting for a manual update: ${manual.map((m) => `${m.name} ${m.updateVersion}`).join(", ")}`,
    );
  const brokenRollback = environments.some((e) =>
    e.items.some((i) => i.outcome === "failed" && i.detail.includes("Check the site now")),
  );
  await deps.notifier.notify?.({
    kind: counts.problems ? "autoupdate.problems" : "autoupdate.completed",
    title: counts.problems
      ? `Scheduled updates had problems on ${site.name}`
      : `Scheduled updates installed on ${site.name} (${counts.updated})`,
    body: lines.join("\n").slice(0, 3000),
    severity: brokenRollback ? "critical" : counts.problems ? "warning" : "info",
    siteIds: [site.id],
  });
}
