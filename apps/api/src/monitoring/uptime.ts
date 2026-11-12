// Uptime monitoring (Phase 3 step 2, A149). Every 5 minutes the runner fetches each active
// site's production homepage (one batched job on its own queue); this module stores each
// result, opens an incident after two failed checks in a row ("down" alert) and closes it on
// the next good one ("up" alert). Read-only on the sites, so the schedule is not an
// approval-gated bulk action; routine runs aren't audited, incidents and manual actions are.
import {
  nextUptimeState,
  UPTIME_INCIDENT_DAYS,
  UPTIME_INTERVAL_MS,
  UPTIME_SAMPLE_DAYS,
  type UptimeHour,
  type UptimeIncidentView,
  UptimeJobResult,
  uptimePercent,
  UptimeProbe,
  UptimeRunStatus,
  type UptimeSiteView,
  type UptimeSummary,
  type UptimeWindow,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type {
  Prisma,
  SiteEnvironment,
  UptimeIncident,
  UptimeMonitor,
} from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const STATUS_KEY = "monitor.uptime.status";
/** 500 probes, 10 at a time, 2 × 10 s worst case each. */
const FULL_TIMEOUT_MS = 4 * 60_000;
const SITE_TIMEOUT_MS = 45_000;
/** With this many sites or more, all failing at once means the hub's network, not the sites. */
const ALL_FAILED_GUARD = 3;

export interface UptimeDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };
type Site = { id: string; name: string };
type EnvRow = SiteEnvironment & {
  site: Site;
  uptimeMonitor: UptimeMonitor | null;
  lock: { environmentId: string } | null;
};

let running = false;
let lastRun: Promise<unknown> = Promise.resolve();
/** The most recent background run (tests wait on it). */
export const lastUptimeRun = () => lastRun;

const StoredStatus = UptimeRunStatus.omit({ running: true });
type StoredStatus = Omit<UptimeRunStatus, "running">;
const EMPTY: StoredStatus = { lastAttemptAt: null, lastSuccessAt: null, ok: null, error: null };

export async function readUptimeStatus(db: Db): Promise<UptimeRunStatus> {
  const row = await db.setting.findUnique({ where: { key: STATUS_KEY } });
  const parsed = StoredStatus.safeParse(row?.value ?? {});
  return { ...(parsed.success ? parsed.data : EMPTY), running };
}

async function writeStatus(db: Db, value: StoredStatus): Promise<void> {
  const json = value as unknown as Prisma.InputJsonObject;
  await db.setting.upsert({
    where: { key: STATUS_KEY },
    create: { key: STATUS_KEY, value: json },
    update: { value: json },
  });
}

export type UptimeStartOutcome =
  { ok: true } | { ok: false; error: "uptime_running" | "uptime_paused" };

/** Starts a run in the background: every monitored site, or one (`siteId`, "Check now"). */
export async function startUptimeCheck(
  deps: UptimeDeps,
  actor: Actor,
  siteId?: string,
): Promise<UptimeStartOutcome> {
  if (running) return { ok: false, error: "uptime_running" };
  running = true;
  let envs: EnvRow[];
  try {
    envs = await monitoredEnvironments(deps.db, siteId);
  } catch (error) {
    running = false;
    throw error;
  }
  if (siteId && envs.length === 0) {
    running = false;
    return { ok: false, error: "uptime_paused" };
  }
  const run = runUptime(deps, actor, envs, siteId === undefined)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "uptime_check_crashed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => {
      running = false;
    });
  lastRun = run;
  return { ok: true };
}

/** Production environments of active sites with monitoring on. */
function monitoredEnvironments(db: Db, siteId?: string): Promise<EnvRow[]> {
  return db.siteEnvironment.findMany({
    where: {
      kind: "PRODUCTION",
      uptimeEnabled: true,
      site: { archived: false, ...(siteId ? { id: siteId } : {}) },
    },
    include: {
      site: { select: { id: true, name: true } },
      uptimeMonitor: true,
      lock: { select: { environmentId: true } },
    },
  });
}

async function runUptime(
  deps: UptimeDeps,
  actor: Actor,
  envs: EnvRow[],
  full: boolean,
): Promise<void> {
  const { db, now } = deps;
  const started = now();
  const manual = actor.userId !== null;

  const finish = async (error: string | null, meta: Prisma.InputJsonObject = {}) => {
    if (full) {
      const previous = await readUptimeStatus(db);
      await writeStatus(db, {
        lastAttemptAt: started.toISOString(),
        lastSuccessAt: error ? previous.lastSuccessAt : now().toISOString(),
        ok: error === null,
        error,
      });
    }
    if (manual)
      await audit(
        db,
        {
          userId: actor.userId,
          action: "monitor.uptime.check",
          result: error ? "failure" : "success",
          ip: actor.ip,
          siteIds: envs.map((e) => e.site.id),
          meta: error ? { error: error.slice(0, 300) } : meta,
        },
        now(),
      );
  };

  if (full) {
    await closeUnmonitored(deps, envs, started);
    await prune(db, started);
  }

  const probes = envs.flatMap((env) => {
    const probe = UptimeProbe.safeParse({ id: env.id, url: env.url, sshHost: env.sshHost });
    return probe.success ? [probe.data] : [];
  });
  if (probes.length === 0) return finish(null, { sites: 0 });

  let raw: unknown;
  try {
    raw = await deps.runner.run(
      { type: "monitor.uptime", probes },
      full ? FULL_TIMEOUT_MS : SITE_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof RunnerUnavailableError)
      return finish("The runner did not answer in time.");
    if (error instanceof RunnerJobFailedError) return finish(error.message);
    throw error;
  }
  const parsed = UptimeJobResult.safeParse(raw);
  if (!parsed.success) return finish("The runner returned an unexpected answer.");
  const results = parsed.data.results;

  // Every site failing in the same run is the hub's own network (or the runner's), not the
  // sites: record nothing rather than alert for every client at once.
  if (full && results.length >= ALL_FAILED_GUARD && results.every((r) => !r.ok))
    return finish(
      "Every site failed at once, so the problem is probably the hub's own network. Nothing was recorded; the next check runs in 5 minutes.",
    );

  const at = now();
  const byId = new Map(results.map((r) => [r.id, r]));
  const summary = { sites: 0, failed: 0, opened: 0, closed: 0 };
  for (const env of envs) {
    const r = byId.get(env.id);
    if (!r) continue;
    summary.sites++;
    if (!r.ok) summary.failed++;
    const excluded = env.lock !== null;
    const prev = env.uptimeMonitor;
    const state = nextUptimeState(
      { failures: prev?.failures ?? 0, down: Boolean(prev?.incidentId) },
      r.ok,
      excluded,
    );
    const failingSince = state.failures > 0 ? (prev?.failingSince ?? at) : null;
    let incidentId = prev?.incidentId ?? null;

    await db.uptimeCheck.create({
      data: {
        environmentId: env.id,
        checkedAt: at,
        ok: r.ok,
        status: r.status,
        responseMs: r.responseMs,
        error: r.error,
        excluded,
      },
    });

    if (state.opened) {
      const incident = await db.uptimeIncident.create({
        data: {
          environmentId: env.id,
          startedAt: failingSince ?? at,
          error: r.error,
          failedChecks: state.failures,
        },
      });
      incidentId = incident.id;
      summary.opened++;
      await deps.notifier.notify?.({
        kind: "uptime.down",
        title: `Site down: ${env.site.name}`,
        body: `${env.url} failed ${state.failures} checks in a row since ${hhmm(failingSince ?? at)} UTC: ${r.error ?? "no answer"}. UlixOps keeps checking every 5 minutes and tells you when it's back.`,
        severity: "critical",
        siteIds: [env.site.id],
        scope: env.id,
      });
      await incidentAudit(db, "monitor.uptime.down", env, at, {
        incidentId: incident.id,
        error: r.error,
        status: r.status,
      });
    } else if (state.down && incidentId && !r.ok && !excluded) {
      await db.uptimeIncident.update({
        where: { id: incidentId },
        data: { failedChecks: { increment: 1 } },
      });
    }

    if (state.closed && incidentId) {
      const incident = await db.uptimeIncident.update({
        where: { id: incidentId },
        data: { endedAt: at, endReason: "recovered" },
      });
      summary.closed++;
      await deps.notifier.notify?.({
        kind: "uptime.up",
        title: `Site back up: ${env.site.name}`,
        body: `${env.url} is answering again (HTTP ${r.status ?? "?"}, ${r.responseMs} ms) after ${durationText(at.getTime() - incident.startedAt.getTime())} down.`,
        severity: "info",
        siteIds: [env.site.id],
        scope: env.id,
      });
      await incidentAudit(db, "monitor.uptime.up", env, at, {
        incidentId,
        downMinutes: Math.round((at.getTime() - incident.startedAt.getTime()) / 60_000),
      });
      incidentId = null;
    }

    const data = {
      checkedAt: at,
      ok: r.ok,
      status: r.status,
      responseMs: r.responseMs,
      error: r.error,
      failures: state.failures,
      failingSince,
      incidentId,
    };
    await db.uptimeMonitor.upsert({
      where: { environmentId: env.id },
      create: { environmentId: env.id, ...data },
      update: data,
    });
  }
  await finish(null, summary);
}

function incidentAudit(
  db: Db,
  action: string,
  env: EnvRow,
  at: Date,
  meta: Prisma.InputJsonObject,
) {
  return audit(
    db,
    { userId: null, action, result: "success", ip: null, siteIds: [env.site.id], meta },
    at,
  );
}

/** Incidents of sites no longer monitored (paused, archived, staging) end as "paused". */
async function closeUnmonitored(deps: UptimeDeps, monitored: EnvRow[], at: Date): Promise<void> {
  const ids = monitored.map((e) => e.id);
  const open = await deps.db.uptimeIncident.findMany({
    where: { endedAt: null, environmentId: { notIn: ids } },
    select: { environmentId: true },
  });
  for (const { environmentId } of open) await endMonitoring(deps.db, environmentId, at);
}

/** Close the open incident without an "up" alert and forget the failure streak. */
export async function endMonitoring(db: Db, environmentId: string, at: Date): Promise<void> {
  await db.uptimeIncident.updateMany({
    where: { environmentId, endedAt: null },
    data: { endedAt: at, endReason: "paused" },
  });
  await db.uptimeMonitor.updateMany({
    where: { environmentId },
    data: { failures: 0, failingSince: null, incidentId: null },
  });
}

/** Samples older than 30 days and incidents that ended over a year ago. */
async function prune(db: Db, at: Date): Promise<void> {
  await db.uptimeCheck.deleteMany({
    where: { checkedAt: { lt: new Date(at.getTime() - UPTIME_SAMPLE_DAYS * DAY) } },
  });
  await db.uptimeIncident.deleteMany({
    where: { endedAt: { lt: new Date(at.getTime() - UPTIME_INCIDENT_DAYS * DAY) } },
  });
}

function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/** "3 min", "2 h 5 min", "1 d 4 h". */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

// ---- Views ---------------------------------------------------------------------------------

type Windows = { day: UptimeWindow; week: UptimeWindow; month: UptimeWindow };
const EMPTY_WINDOW: UptimeWindow = { checks: 0, failed: 0, percent: null, avgResponseMs: null };

/** Uptime over 24 h, 7 and 30 days per environment; checks during hub jobs don't count. */
export async function uptimeWindows(
  db: Db,
  environmentIds: string[],
  at: Date,
  spans: (keyof Windows)[] = ["day", "week", "month"],
): Promise<Map<string, Windows>> {
  const out = new Map<string, Windows>(
    environmentIds.map((id) => [
      id,
      { day: EMPTY_WINDOW, week: EMPTY_WINDOW, month: EMPTY_WINDOW },
    ]),
  );
  if (environmentIds.length === 0) return out;
  const days: Record<keyof Windows, number> = { day: 1, week: 7, month: 30 };
  for (const span of spans) {
    const groups = await db.uptimeCheck.groupBy({
      by: ["environmentId", "ok"],
      where: {
        environmentId: { in: environmentIds },
        excluded: false,
        checkedAt: { gte: new Date(at.getTime() - days[span] * DAY) },
      },
      _count: { _all: true },
      _avg: { responseMs: true },
    });
    const totals = new Map<string, { checks: number; failed: number; avg: number | null }>();
    for (const g of groups) {
      const t = totals.get(g.environmentId) ?? { checks: 0, failed: 0, avg: null };
      t.checks += g._count._all;
      if (!g.ok) t.failed += g._count._all;
      else t.avg = g._avg.responseMs;
      totals.set(g.environmentId, t);
    }
    for (const [id, t] of totals) {
      const windows = out.get(id);
      if (!windows) continue;
      windows[span] = {
        checks: t.checks,
        failed: t.failed,
        percent: uptimePercent(t.checks, t.failed),
        avgResponseMs: t.avg === null ? null : Math.round(t.avg),
      };
    }
  }
  return out;
}

export type ViewEnv = SiteEnvironment & { site: Site; uptimeMonitor: UptimeMonitor | null };

export function uptimeSiteView(
  env: ViewEnv,
  windows: Windows | undefined,
  openIncident: UptimeIncident | undefined,
): UptimeSiteView {
  const m = env.uptimeMonitor;
  return {
    siteId: env.site.id,
    siteName: env.site.name,
    url: env.url,
    state: !env.uptimeEnabled ? "paused" : !m ? "unknown" : m.incidentId ? "down" : "up",
    enabled: env.uptimeEnabled,
    checkedAt: m?.checkedAt.toISOString() ?? null,
    status: m?.status ?? null,
    responseMs: m?.responseMs ?? null,
    error: m && !m.ok ? m.error : null,
    downSince: openIncident?.startedAt.toISOString() ?? null,
    ...(windows ?? { day: EMPTY_WINDOW, week: EMPTY_WINDOW, month: EMPTY_WINDOW }),
  };
}

export function incidentView(
  row: UptimeIncident & { environment: { site: Site } },
): UptimeIncidentView {
  return {
    id: row.id,
    siteId: row.environment.site.id,
    siteName: row.environment.site.name,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    error: row.error,
    failedChecks: row.failedChecks,
  };
}

/** Open incidents and those started in the last 30 days, newest first. */
export async function recentIncidents(
  db: Db,
  at: Date,
  where: Prisma.UptimeIncidentWhereInput = {},
  take = 100,
): Promise<UptimeIncidentView[]> {
  const rows = await db.uptimeIncident.findMany({
    where: {
      ...where,
      OR: [{ endedAt: null }, { startedAt: { gte: new Date(at.getTime() - 30 * DAY) } }],
    },
    include: { environment: { select: { site: { select: { id: true, name: true } } } } },
    orderBy: { startedAt: "desc" },
    take,
  });
  return rows.map(incidentView);
}

/** The last 24 hours of one environment in hourly buckets, oldest first. */
export async function uptimeHours(db: Db, environmentId: string, at: Date): Promise<UptimeHour[]> {
  const first = Math.floor(at.getTime() / HOUR) * HOUR - 23 * HOUR;
  const rows = await db.uptimeCheck.findMany({
    where: { environmentId, excluded: false, checkedAt: { gte: new Date(first) } },
    select: { checkedAt: true, ok: true, responseMs: true },
  });
  const hours = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(first + i * HOUR).toISOString(),
    checks: 0,
    failed: 0,
    sum: 0,
    okCount: 0,
  }));
  for (const r of rows) {
    const bucket = hours[Math.floor((r.checkedAt.getTime() - first) / HOUR)];
    if (!bucket) continue;
    bucket.checks++;
    if (!r.ok) bucket.failed++;
    else if (r.responseMs !== null) {
      bucket.sum += r.responseMs;
      bucket.okCount++;
    }
  }
  return hours.map(({ hour, checks, failed, sum, okCount }) => ({
    hour,
    checks,
    failed,
    avgResponseMs: okCount ? Math.round(sum / okCount) : null,
  }));
}

/** Sites list: production uptime summary per environment id. */
export async function uptimeSummaries(
  db: Db,
  envs: { id: string; uptimeEnabled: boolean }[],
  at: Date,
): Promise<Map<string, UptimeSummary>> {
  const ids = envs.map((e) => e.id);
  const out = new Map<string, UptimeSummary>();
  if (ids.length === 0) return out;
  const [monitors, open, windows] = await Promise.all([
    db.uptimeMonitor.findMany({ where: { environmentId: { in: ids } } }),
    db.uptimeIncident.findMany({ where: { environmentId: { in: ids }, endedAt: null } }),
    uptimeWindows(db, ids, at, ["day"]),
  ]);
  const monitorOf = new Map(monitors.map((m) => [m.environmentId, m]));
  const openOf = new Map(open.map((i) => [i.environmentId, i]));
  for (const env of envs) {
    const m = monitorOf.get(env.id);
    out.set(env.id, {
      state: !env.uptimeEnabled ? "paused" : !m ? "unknown" : m.incidentId ? "down" : "up",
      since: openOf.get(env.id)?.startedAt.toISOString() ?? null,
      percent24h: windows.get(env.id)?.day.percent ?? null,
      responseMs: m?.ok ? m.responseMs : null,
    });
  }
  return out;
}

// ---- Schedule ------------------------------------------------------------------------------

/** Checks every site every 5 minutes (first run after `firstDelayMs`); returns a stop function. */
export function startUptimeScheduler(
  deps: UptimeDeps,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const tick = async () => {
    try {
      // A run still going (slow sites) just means this tick is skipped.
      await startUptimeCheck(deps, { userId: null, ip: null });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "uptime_schedule_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const first = setTimeout(() => void tick(), opts.firstDelayMs ?? 60_000);
  const every = setInterval(() => void tick(), opts.intervalMs ?? UPTIME_INTERVAL_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
