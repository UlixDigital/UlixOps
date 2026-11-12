// File integrity checks (Phase 2 step 4, A144): the runner compares WordPress core and
// WordPress.org plugins with their official checksums over SSH; this module records the results,
// applies known-safe rules, alerts on changes that weren't there last time, and runs a daily
// check of each site (one at a time, in the malware scan schedule's window).
import { inScheduleWindow, IntegrityJobResult, type IntegrityCheckView } from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type {
  IntegrityCheck,
  IntegrityFinding,
  Prisma,
  SiteEnvironment,
} from "../generated/prisma/client";
import { autoScanWhere, emailsOf, readSchedule } from "../malware/service";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

/** Core (≤2 min) + plugins (≤5 min) + headroom. */
const CHECK_TIMEOUT_MS = 9 * 60_000;
/** A RUNNING check older than this was cut off (API restart). */
export const STALE_CHECK_MS = 30 * 60_000;
/** Each covered environment is checked once a day. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** After a failed check, that environment waits this long before the next automatic try. */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000;

export interface IntegrityDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };
type EnvWithSite = SiteEnvironment & { site: { id: string; name: string } };
export type CheckRow = IntegrityCheck & {
  findings?: IntegrityFinding[];
  environment: EnvWithSite;
  _count?: { findings: number };
};

export const checkInclude = (withFindings: boolean) =>
  ({
    environment: {
      include: { site: { select: { id: true, name: true, tags: true, archived: true } } },
    },
    _count: { select: { findings: { where: { ignored: false } } } },
    ...(withFindings
      ? {
          findings: {
            orderBy: [{ ignored: "asc" }, { scope: "asc" }, { component: "asc" }, { path: "asc" }],
          },
        }
      : {}),
  }) as const satisfies Prisma.IntegrityCheckInclude;

const key = (f: { scope: string; component: string; path: string }) =>
  `${f.scope}\u0000${f.component}\u0000${f.path}`;

export async function checkViews(db: Db, rows: CheckRow[]): Promise<IntegrityCheckView[]> {
  const emails = await emailsOf(
    db,
    rows.map((r) => r.requestedById),
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.environment.site.id,
    siteName: row.environment.site.name,
    environment: row.environment.kind,
    status: row.status as IntegrityCheckView["status"],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    requestedBy: row.requestedById ? (emails.get(row.requestedById) ?? null) : null,
    detail: row.detail,
    coreChecked: row.coreChecked,
    pluginsChecked: row.pluginsChecked,
    verifiedPlugins: row.verifiedPlugins,
    unverifiable: row.unverifiable,
    findingCount: row._count?.findings ?? (row.findings ?? []).filter((f) => !f.ignored).length,
    findings: (row.findings ?? []).map((f) => ({
      id: f.id,
      scope: f.scope as "core" | "plugin",
      component: f.component,
      path: f.path,
      issue: f.issue as "modified" | "added" | "missing",
      ignored: f.ignored,
    })),
  }));
}

/** Checks cut off long ago (or by a restart, with `all`) can't finish: mark them failed. */
export async function expireStaleChecks(db: Db, at: Date, all = false): Promise<number> {
  const { count } = await db.integrityCheck.updateMany({
    where: {
      status: "RUNNING",
      ...(all ? {} : { startedAt: { lt: new Date(at.getTime() - STALE_CHECK_MS) } }),
    },
    data: {
      status: "FAILED",
      finishedAt: at,
      detail: "Interrupted: the hub restarted while this check was running. Check again.",
    },
  });
  return count;
}

export type StartOutcome =
  { ok: true; checkId: string } | { ok: false; error: "check_running" | "connection_untested" };

/** Starts a check in the background; `userId` null = daily schedule. */
export async function startIntegrityCheck(
  deps: IntegrityDeps,
  env: EnvWithSite,
  actor: Actor,
): Promise<StartOutcome> {
  const { db, now } = deps;
  if (!env.hostKey) return { ok: false, error: "connection_untested" };
  await expireStaleChecks(db, now());
  if ((await db.integrityCheck.count({ where: { environmentId: env.id, status: "RUNNING" } })) > 0)
    return { ok: false, error: "check_running" };
  const check = await db.integrityCheck.create({
    data: {
      environmentId: env.id,
      status: "RUNNING",
      requestedById: actor.userId,
      startedAt: now(),
      unverifiable: [],
    },
  });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.integrity.start",
      result: "pending",
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: { kind: env.kind, checkId: check.id, scheduled: actor.userId === null },
    },
    now(),
  );
  const hostKey = env.hostKey;
  const run = runCheck(deps, env, check.id, actor, hostKey).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "integrity_check_crashed",
        checkId: check.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  lastRun = run;
  return { ok: true, checkId: check.id };
}

/** The most recent background run (tests wait on it). */
let lastRun: Promise<void> = Promise.resolve();
export const lastIntegrityRun = () => lastRun;

async function runCheck(
  deps: IntegrityDeps,
  env: EnvWithSite,
  checkId: string,
  actor: Actor,
  hostKey: string,
): Promise<void> {
  const { db, now } = deps;
  const fail = async (detail: string) => {
    await db.integrityCheck.updateMany({
      where: { id: checkId, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: now(), detail: detail.slice(0, 2000) },
    });
    await audit(
      db,
      {
        userId: actor.userId,
        action: "site.integrity.result",
        result: "failure",
        ip: actor.ip,
        siteIds: [env.site.id],
        meta: { kind: env.kind, checkId, detail: detail.slice(0, 300) },
      },
      now(),
    );
  };

  let raw: unknown;
  try {
    raw = await deps.runner.run(
      {
        type: "site.integrity",
        target: {
          host: env.sshHost,
          port: env.sshPort,
          user: env.sshUser,
          wpPath: env.wpPath,
          credentialRef: env.credentialRef,
          hostKey,
        },
      },
      CHECK_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof RunnerUnavailableError) return fail("The runner did not answer in time.");
    if (error instanceof RunnerJobFailedError) return fail(error.message);
    throw error;
  }
  const parsed = IntegrityJobResult.safeParse(raw);
  if (!parsed.success) return fail("The runner returned an unexpected answer.");
  const result = parsed.data;
  if (result.hostKeyMismatch)
    return fail("Refused: the server's SSH host key no longer matches the pinned one.");
  if (!result.coreChecked && !result.pluginsChecked) return fail(result.detail);

  const rules = await db.integrityIgnore.findMany({ where: { environmentId: env.id } });
  const safe = new Set(rules.map(key));
  const findings = result.findings.map((f) => ({ ...f, ignored: safe.has(key(f)) }));
  const real = findings.filter((f) => !f.ignored);
  const knownSafe = findings.length - real.length;

  // Alert only on changes the previous finished check didn't already report.
  const previous = await db.integrityCheck.findFirst({
    where: { environmentId: env.id, status: { in: ["CLEAN", "CHANGED"] }, id: { not: checkId } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    include: { findings: { where: { ignored: false } } },
  });
  const seen = new Set((previous?.findings ?? []).map(key));
  const fresh = real.filter((f) => !seen.has(key(f)));

  const detail = knownSafe
    ? `${result.detail} ${knownSafe} known-safe change${knownSafe === 1 ? " was" : "s were"} ignored.`
    : result.detail;
  const stored = await db.$transaction(async (tx) => {
    const done = await tx.integrityCheck.updateMany({
      where: { id: checkId, status: "RUNNING" },
      data: {
        status: real.length ? "CHANGED" : "CLEAN",
        finishedAt: now(),
        coreChecked: result.coreChecked,
        pluginsChecked: result.pluginsChecked,
        verifiedPlugins: result.verifiedPlugins,
        unverifiable: result.unverifiable,
        detail: detail.slice(0, 2000),
      },
    });
    if (done.count !== 1) return false;
    if (findings.length)
      await tx.integrityFinding.createMany({ data: findings.map((f) => ({ checkId, ...f })) });
    return true;
  });
  if (!stored) return;
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.integrity.result",
      result: real.length ? "changed" : "clean",
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: { kind: env.kind, checkId, changed: real.length, new: fresh.length, knownSafe },
    },
    now(),
  );
  if (fresh.length && deps.notifier.notify) {
    const lines = fresh
      .slice(0, 10)
      .map((f) =>
        f.scope === "core" ? `${f.path}: ${f.issue}` : `${f.component} › ${f.path}: ${f.issue}`,
      );
    if (fresh.length > 10) lines.push(`…and ${fresh.length - 10} more.`);
    await deps.notifier.notify({
      kind: "integrity.changed",
      title: `Files changed on ${env.site.name} (${env.kind.toLowerCase()})`,
      body: `${fresh.length} file${fresh.length === 1 ? "" : "s"} no longer match the official WordPress.org copies:\n${lines.join("\n")}`,
      severity: "critical",
      siteIds: [env.site.id],
      scope: env.id,
    });
  }
  await deps.notifier.observe?.({
    kind: "integrity.changed",
    siteIds: [env.site.id],
    scope: env.id,
    ok: real.length === 0,
    ...(real.length === 0 && actor.userId
      ? { byUserId: actor.userId, fixAction: "updated_software" as const }
      : {}),
    note:
      real.length === 0
        ? "A later integrity check found every file matching again"
        : `A later integrity check still found ${real.length} changed file${real.length === 1 ? "" : "s"}`,
  });
}

// ---- Known-safe changes --------------------------------------------------------------------

async function restatus(db: Db, checkId: string): Promise<void> {
  const check = await db.integrityCheck.findUnique({ where: { id: checkId } });
  if (!check || (check.status !== "CLEAN" && check.status !== "CHANGED")) return;
  const real = await db.integrityFinding.count({ where: { checkId, ignored: false } });
  const status = real > 0 ? "CHANGED" : "CLEAN";
  if (status !== check.status)
    await db.integrityCheck.update({ where: { id: checkId }, data: { status } });
}

/** Marks a reviewed change as safe for this environment: this and later checks ignore it. */
export async function markChangeSafe(
  deps: IntegrityDeps,
  findingId: string,
  reason: string,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: boolean }> {
  const { db, now } = deps;
  const finding = await db.integrityFinding.findUnique({
    where: { id: findingId },
    include: {
      check: { include: { environment: { select: { id: true, kind: true, siteId: true } } } },
    },
  });
  if (!finding) return { ok: false };
  const env = finding.check.environment;
  await db.integrityIgnore.upsert({
    where: {
      environmentId_scope_component_path: {
        environmentId: env.id,
        scope: finding.scope,
        component: finding.component,
        path: finding.path,
      },
    },
    create: {
      environmentId: env.id,
      scope: finding.scope,
      component: finding.component,
      path: finding.path,
      reason,
      createdById: actor.userId,
      createdAt: now(),
    },
    update: { reason },
  });
  const affected = await db.integrityFinding.findMany({
    where: {
      scope: finding.scope,
      component: finding.component,
      path: finding.path,
      ignored: false,
      check: { environmentId: env.id },
    },
    select: { id: true, checkId: true },
  });
  await db.integrityFinding.updateMany({
    where: { id: { in: affected.map((f) => f.id) } },
    data: { ignored: true },
  });
  for (const id of new Set(affected.map((f) => f.checkId))) await restatus(db, id);
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.integrity.mark_safe",
      result: "success",
      ip: actor.ip,
      siteIds: [env.siteId],
      meta: {
        kind: env.kind,
        scope: finding.scope,
        component: finding.component,
        path: finding.path,
        reason,
      },
    },
    now(),
  );
  // If every remaining change on the latest check is known-safe, close the integrity alert (A176).
  const latest = await db.integrityCheck.findFirst({
    where: { environmentId: env.id, status: { in: ["CLEAN", "CHANGED"] } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest) {
    const remaining = await db.integrityFinding.count({
      where: { checkId: latest.id, ignored: false },
    });
    if (remaining === 0)
      await deps.notifier.observe?.({
        kind: "integrity.changed",
        siteIds: [env.siteId],
        scope: env.id,
        ok: true,
        byUserId: actor.userId,
        fixAction: "marked_known_safe",
        note: `Marked remaining changes known-safe: ${reason.slice(0, 200)}`,
      });
  }
  return { ok: true };
}

/** Removes a known-safe rule; the environment's latest check counts the change again. */
export async function removeChangeRule(
  deps: IntegrityDeps,
  ruleId: string,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: boolean }> {
  const { db, now } = deps;
  const rule = await db.integrityIgnore.findUnique({
    where: { id: ruleId },
    include: { environment: { select: { kind: true, siteId: true } } },
  });
  if (!rule) return { ok: false };
  await db.integrityIgnore.delete({ where: { id: rule.id } });
  const latest = await db.integrityCheck.findFirst({
    where: { environmentId: rule.environmentId, status: { in: ["CLEAN", "CHANGED"] } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest) {
    await db.integrityFinding.updateMany({
      where: { checkId: latest.id, scope: rule.scope, component: rule.component, path: rule.path },
      data: { ignored: false },
    });
    await restatus(db, latest.id);
  }
  await audit(
    db,
    {
      userId: actor.userId,
      action: "site.integrity.unmark_safe",
      result: "success",
      ip: actor.ip,
      siteIds: [rule.environment.siteId],
      meta: {
        kind: rule.environment.kind,
        scope: rule.scope,
        component: rule.component,
        path: rule.path,
      },
    },
    now(),
  );
  return { ok: true };
}

// ---- Daily schedule ------------------------------------------------------------------------

/** The covered environment most overdue for its daily check, if any. */
export async function nextDueIntegrityEnv(db: Db, at: Date): Promise<EnvWithSite | null> {
  const schedule = await readSchedule(db);
  const envs = await db.siteEnvironment.findMany({
    where: { ...autoScanWhere(schedule), integrityChecks: { none: { status: "RUNNING" } } },
    include: {
      site: { select: { id: true, name: true } },
      integrityChecks: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { startedAt: true, status: true },
      },
    },
  });
  const due = envs
    .map((env) => {
      const last = env.integrityChecks[0];
      const wait = last?.status === "FAILED" ? RETRY_AFTER_FAILURE_MS : CHECK_EVERY_MS;
      return { env, last: last?.startedAt.getTime() ?? 0, wait };
    })
    .filter((e) => at.getTime() - e.last >= e.wait)
    .sort((a, b) => a.last - b.last || a.env.site.name.localeCompare(b.env.site.name));
  const pick = due[0]?.env;
  if (!pick) return null;
  const { integrityChecks: _ignored, ...env } = pick;
  return env;
}

/**
 * One automatic check at a time, only inside the schedule window and never while a malware scan
 * runs (both hold a runner slot; this keeps one free for people's actions).
 */
export async function dispatchIntegrity(deps: IntegrityDeps): Promise<void> {
  const { db, now } = deps;
  const at = now();
  await expireStaleChecks(db, at);
  const schedule = await readSchedule(db);
  if (!schedule.enabled || !schedule.integrityEnabled || !inScheduleWindow(schedule, at)) return;
  if ((await db.integrityCheck.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.malwareScan.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.fullBackup.count({ where: { status: "RUNNING" } })) > 0) return;
  if ((await db.fullRestore.count({ where: { status: "RUNNING" } })) > 0) return;
  const env = await nextDueIntegrityEnv(db, at);
  if (env) await startIntegrityCheck(deps, env, { userId: null, ip: null });
}
