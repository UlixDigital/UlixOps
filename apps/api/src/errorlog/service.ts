// Central PHP error log viewer (Phase 4 step 1, A159). Production sites' debug.log is read
// every 6 hours (hourly tick) and on demand; the latest reading per environment is kept, and a
// fatal error newer than the last one alerted on raises `php.fatal`.
import {
  DebugConstants,
  DebugLogJobResult,
  ERRORLOG_EVERY_MS,
  loggingState,
  ErrorGroup,
  ErrorLogJobResult,
  type ErrorLogRow,
  type ErrorLogView,
  errorCounts,
  SERIOUS_LEVELS,
} from "@ulixops/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Db } from "../db";
import { type PhpErrorLog, Prisma, type SiteEnvironment } from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

export interface ErrorLogDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier?: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };
type EnvWithSite = SiteEnvironment & { site: { id: string; name: string } };

const JOB_TIMEOUT_MS = 90_000;
/** Per tick at most; the rest wait for the next hour. */
const MAX_PER_TICK = 40;

const Groups = z.array(ErrorGroup);
const groupsOf = (json: unknown) => {
  const parsed = Groups.safeParse(json);
  return parsed.success ? parsed.data : [];
};

/** Reads one environment's log and stores it. Returns the stored row. */
export async function readSiteErrorLog(
  deps: ErrorLogDeps,
  env: EnvWithSite,
  actor: Actor,
): Promise<PhpErrorLog> {
  const { db, now } = deps;
  const prev = await db.phpErrorLog.findUnique({ where: { environmentId: env.id } });
  const store = async (data: Omit<Prisma.PhpErrorLogUncheckedCreateInput, "environmentId">) =>
    db.phpErrorLog.upsert({
      where: { environmentId: env.id },
      create: { environmentId: env.id, ...data },
      update: data,
    });
  const failed = async (detail: string) => {
    // Keep the last good groups; only mark that this reading failed.
    const row = await store({ readAt: now(), ok: false, detail: detail.slice(0, 500) });
    if (actor.userId) await record(deps, env, actor, "failure", { detail: detail.slice(0, 200) });
    return row;
  };
  if (!env.hostKey) return failed("The site's connection isn't tested (no pinned host key).");

  let raw: unknown;
  try {
    raw = await deps.runner.run(
      {
        type: "site.errorlog",
        target: {
          host: env.sshHost,
          port: env.sshPort,
          user: env.sshUser,
          wpPath: env.wpPath,
          credentialRef: env.credentialRef,
          hostKey: env.hostKey,
        },
        trim: prev?.managed === true,
      },
      JOB_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof RunnerUnavailableError)
      return failed("The runner did not answer in time.");
    if (error instanceof RunnerJobFailedError) return failed(error.message);
    throw error;
  }
  const parsed = ErrorLogJobResult.safeParse(raw);
  if (!parsed.success) return failed("The runner returned an unexpected answer.");
  const result = parsed.data;
  if (result.hostKeyMismatch)
    return failed("Refused: the server's SSH host key no longer matches the pinned one.");

  // UlixOps switched logging on (mu-plugin), then plugin was removed by hand or host.
  const reverted = prev?.managed === true && result.pluginInstalled === false;
  if (reverted)
    await audit(
      db,
      {
        userId: null,
        action: "site.debuglog.reverted",
        result: "alert",
        ip: null,
        siteIds: [env.site.id],
        meta: { kind: env.kind, debug: result.debug, pluginInstalled: false },
      },
      now(),
    );
  const counts = errorCounts(result.groups);
  const fatals = result.groups.filter(
    (g) => (g.level === "fatal" || g.level === "parse") && g.lastAt,
  );
  const newest = fatals.reduce<string | null>(
    (max, g) => (g.lastAt && (!max || g.lastAt > max) ? g.lastAt : max),
    null,
  );
  const since = prev?.lastFatalAt?.toISOString() ?? null;
  // Alert only on fatal errors newer than the last one alerted on, and from the last 24 hours
  // (an old error in a log nobody cleared isn't news).
  const dayAgo = new Date(now().getTime() - 86_400_000).toISOString();
  const fresh = fatals.filter(
    (g) => g.lastAt && g.lastAt >= dayAgo && (!since || g.lastAt > since),
  );
  const row = await store({
    readAt: now(),
    ok: true,
    detail: null,
    fileFound: result.fileFound,
    sizeBytes: BigInt(result.sizeBytes),
    modifiedAt: result.modifiedAt ? new Date(result.modifiedAt) : null,
    truncated: result.truncated,
    groups: result.groups as unknown as Prisma.InputJsonArray,
    fatal24h: counts.fatal,
    errors24h: counts.errors,
    warnings24h: counts.warnings,
    lastFatalAt: newest ? new Date(newest) : (prev?.lastFatalAt ?? null),
    ...(result.pluginInstalled
      ? {
          debug: {
            WP_DEBUG: true,
            WP_DEBUG_LOG: true,
            WP_DEBUG_DISPLAY: false,
          },
        }
      : result.debug
        ? { debug: result.debug }
        : {}),
    ...(reverted
      ? { managed: false, previousDebug: Prisma.DbNull, managedAt: null, managedById: null }
      : {}),
  });
  if (fresh.length > 0) {
    const label = `${env.site.name} (${env.kind.toLowerCase()})`;
    await deps.notifier?.notify?.({
      kind: "php.fatal",
      title: `PHP fatal error: ${label}`,
      body: fresh
        .slice(0, 3)
        .map((g) => `${g.message.slice(0, 200)}${g.source ? ` [${g.source}]` : ""} ×${g.count24h}`)
        .join("\n"),
      severity: "warning",
      siteIds: [env.site.id],
    });
    await audit(
      db,
      {
        userId: null,
        action: "site.errorlog.fatal",
        result: "alert",
        ip: null,
        siteIds: [env.site.id],
        meta: { kind: env.kind, messages: fresh.slice(0, 5).map((g) => g.message.slice(0, 200)) },
      },
      now(),
    );
  } else if (counts.fatal === 0) {
    // Fatals gone from the last 24 h → close any open php.fatal alert for this site (A176).
    await deps.notifier?.observe?.({
      kind: "php.fatal",
      siteIds: [env.site.id],
      ok: true,
      note: "No PHP fatal errors in the last 24 hours",
    });
  }
  if (actor.userId) await record(deps, env, actor, "success", { ...counts });
  return row;
}

function record(
  deps: ErrorLogDeps,
  env: EnvWithSite,
  actor: Actor,
  result: "success" | "failure",
  meta: Record<string, string | number>,
) {
  return audit(
    deps.db,
    {
      userId: actor.userId,
      action: "site.errorlog.read",
      result,
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: { kind: env.kind, ...meta },
    },
    deps.now(),
  );
}

// ---- Schedule ------------------------------------------------------------------------------

let collecting = false;
export const isCollecting = () => collecting;

/** Production sites whose last reading is older than 6 hours (or never), one at a time. */
export async function collectDueErrorLogs(deps: ErrorLogDeps): Promise<number> {
  if (collecting) return 0;
  collecting = true;
  try {
    const before = new Date(deps.now().getTime() - ERRORLOG_EVERY_MS);
    const envs = await deps.db.siteEnvironment.findMany({
      where: {
        kind: "PRODUCTION",
        hostKey: { not: null },
        site: { archived: false },
        OR: [{ phpErrorLog: null }, { phpErrorLog: { readAt: { lt: before } } }],
      },
      include: { site: { select: { id: true, name: true } } },
      take: MAX_PER_TICK,
    });
    for (const env of envs) {
      try {
        await readSiteErrorLog(deps, env, { userId: null, ip: null });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "errorlog_read_failed",
            environmentId: env.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return envs.length;
  } finally {
    collecting = false;
  }
}

// ---- Views ---------------------------------------------------------------------------------

export function errorLogView(env: EnvWithSite, row: PhpErrorLog | null): ErrorLogView {
  return {
    environmentId: env.id,
    siteId: env.site.id,
    siteName: env.site.name,
    environment: env.kind,
    readAt: row?.readAt.toISOString() ?? null,
    ok: row?.ok ?? null,
    detail: row?.detail ?? null,
    fileFound: row?.fileFound ?? false,
    sizeBytes: Number(row?.sizeBytes ?? 0n),
    modifiedAt: row?.modifiedAt?.toISOString() ?? null,
    truncated: row?.truncated ?? false,
    logging: (() => {
      const base = loggingState(debugOf(row?.debug));
      const managed = row?.managed ?? false;
      // Managed mu-plugin sites are "on" even if wp-config constants stay unset (A167).
      const state = managed && base.state === "off" ? "on" : base.state;
      return {
        state,
        display: base.display,
        managed,
        viaPlugin: managed,
        enabledAt: row?.managedAt?.toISOString() ?? null,
      };
    })(),
    fatal24h: row?.fatal24h ?? 0,
    errors24h: row?.errors24h ?? 0,
    warnings24h: row?.warnings24h ?? 0,
    groups: groupsOf(row?.groups),
  };
}

export function errorLogRow(env: EnvWithSite, row: PhpErrorLog | null): ErrorLogRow {
  const { groups, ...rest } = errorLogView(env, row);
  const top =
    groups
      .filter((g) => SERIOUS_LEVELS.includes(g.level))
      .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))[0] ?? null;
  return { ...rest, top };
}

// ---- Error logging switch (A160) -----------------------------------------------------------

export const debugOf = (json: unknown): DebugConstants | null => {
  const parsed = DebugConstants.safeParse(json);
  return parsed.success ? parsed.data : null;
};

export type LoggingOutcome =
  | { ok: true; detail: string }
  | { ok: false; error: "logging_not_managed" | "connection_untested"; detail?: string }
  | { ok: false; error: "logging_failed"; exposed: boolean; detail: string };

/**
 * Switch PHP error logging on via UlixOps mu-plugin (A167), or remove that plugin.
 * Legacy wp-config restore is unused for new enables.
 */
export async function setLogging(
  deps: ErrorLogDeps,
  env: EnvWithSite,
  enabled: boolean,
  actor: { userId: string | null; ip: string | null },
): Promise<LoggingOutcome> {
  const { db, now } = deps;
  if (!env.hostKey) return { ok: false, error: "connection_untested" };
  const row = await db.phpErrorLog.findUnique({ where: { environmentId: env.id } });
  if (!enabled && !row?.managed) return { ok: false, error: "logging_not_managed" };
  const raw = await deps.runner.run(
    {
      type: "site.debuglog",
      target: {
        host: env.sshHost,
        port: env.sshPort,
        user: env.sshUser,
        wpPath: env.wpPath,
        credentialRef: env.credentialRef,
        hostKey: env.hostKey,
      },
      action: enabled ? "enable" : "disable",
      siteUrl: env.url,
    },
    JOB_TIMEOUT_MS * 2,
  );
  const parsed = DebugLogJobResult.safeParse(raw);
  const result =
    !parsed.success || parsed.data.hostKeyMismatch
      ? {
          ok: false,
          exposed: false,
          previous: null,
          current: null,
          pluginInstalled: false,
          method: "mu-plugin" as const,
          detail: parsed.success
            ? "Refused: the server's SSH host key no longer matches the pinned one."
            : "The runner returned an unexpected answer.",
        }
      : parsed.data;
  const at = now();
  if (result.ok) {
    const data = enabled
      ? {
          managed: true,
          previousDebug: Prisma.DbNull,
          managedAt: at,
          managedById: actor.userId,
          debug: result.current ?? {
            WP_DEBUG: true,
            WP_DEBUG_LOG: true,
            WP_DEBUG_DISPLAY: false,
          },
        }
      : {
          managed: false,
          previousDebug: Prisma.DbNull,
          managedAt: null,
          managedById: null,
          debug: result.current ?? undefined,
        };
    await db.phpErrorLog.upsert({
      where: { environmentId: env.id },
      create: { environmentId: env.id, readAt: at, ok: true, ...data },
      update: data,
    });
  }
  await audit(
    db,
    {
      userId: actor.userId,
      action: enabled ? "site.debuglog.enable" : "site.debuglog.disable",
      result: result.ok ? "success" : "failure",
      ip: actor.ip,
      siteIds: [env.site.id],
      meta: { kind: env.kind, exposed: result.exposed, detail: result.detail.slice(0, 300) },
    },
    at,
  );
  if (!result.ok)
    return { ok: false, error: "logging_failed", exposed: result.exposed, detail: result.detail };
  return { ok: true, detail: result.detail };
}

/** After a bulk request is approved: switch logging on for each, one at a time. */
export async function enableLoggingBulk(
  deps: ErrorLogDeps,
  environmentIds: string[],
  requestedById: string,
): Promise<{ on: number; failed: number }> {
  const envs = await deps.db.siteEnvironment.findMany({
    where: { id: { in: environmentIds }, site: { archived: false } },
    include: { site: { select: { id: true, name: true } } },
  });
  let on = 0;
  const failed: string[] = [];
  for (const env of envs) {
    const r = await setLogging(deps, env, true, { userId: requestedById, ip: null }).catch(
      (error: unknown) =>
        ({ ok: false, detail: error instanceof Error ? error.message : "failed" }) as const,
    );
    if (r.ok) on++;
    else failed.push(`${env.site.name}: ${("detail" in r && r.detail) || "failed"}`.slice(0, 200));
  }
  await deps.notifier?.notify?.({
    kind: "php.logging",
    title: `PHP error logging switched on for ${on} of ${envs.length} sites`,
    body: failed.length
      ? `Not switched on:\n${failed.slice(0, 10).join("\n")}`
      : "All switched on.",
    severity: failed.length ? "warning" : "info",
    siteIds: envs.map((e) => e.site.id),
    recipientUserIds: [requestedById],
  });
  return { on, failed: failed.length };
}
