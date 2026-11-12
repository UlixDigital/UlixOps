// Visual checks (P4-3, A163): before/after Playwright screenshots around deploys and updates.
import {
  buildVisualPages,
  type NotificationEvent,
  type VisualCaptureResult,
  VisualCaptureResult as VisualCaptureResultSchema,
  type VisualCheckListItem,
  type VisualCheckTrigger,
  type VisualCheckView,
  type VisualPageView,
  VISUAL_KEEP_PER_ENV,
  VISUAL_RETENTION_DAYS,
  visualPageSlug,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import { readHealthSettings } from "../health/settings";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import { readVisualSettings } from "./settings";
import type { VisualStore } from "./store";

export const VISUAL_TIMEOUT_MS = 5 * 60_000;

export interface VisualDeps {
  db: Db;
  runner: RunnerClient;
  store: VisualStore;
  now: () => Date;
  notifier?: SecurityNotifier;
}

type EnvRow = {
  id: string;
  kind: "PRODUCTION" | "STAGING";
  url: string;
  sshHost: string;
  siteId: string;
  site: { id: string; name: string; archived: boolean };
};

function pageViews(
  pages: {
    id: string;
    path: string;
    slug: string;
    role: string;
    url: string;
    ok: boolean;
    httpStatus: number | null;
    detail: string;
    diffPercent: number | null;
    changed: boolean;
    hasBefore: boolean;
    hasAfter: boolean;
    hasDiff: boolean;
  }[],
): VisualPageView[] {
  return pages.map((p) => VisualPageViewShape(p));
}

function VisualPageViewShape(p: {
  id: string;
  path: string;
  slug: string;
  role: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  detail: string;
  diffPercent: number | null;
  changed: boolean;
  hasBefore: boolean;
  hasAfter: boolean;
  hasDiff: boolean;
}): VisualPageView {
  return {
    id: p.id,
    path: p.path,
    slug: p.slug,
    role: p.role === "home" ? "home" : "extra",
    url: p.url,
    ok: p.ok,
    status: p.httpStatus,
    detail: p.detail,
    diffPercent: p.diffPercent,
    changed: p.changed,
    hasBefore: p.hasBefore,
    hasAfter: p.hasAfter,
    hasDiff: p.hasDiff,
  };
}

export function toCheckView(row: {
  id: string;
  environmentId: string;
  trigger: string;
  status: string;
  summary: string;
  maxDiffPercent: number;
  deploymentId: string | null;
  deploymentTargetId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  environment: {
    kind: "PRODUCTION" | "STAGING";
    site: { id: string; name: string };
  };
  pages?: Parameters<typeof pageViews>[0];
}): VisualCheckView {
  return {
    id: row.id,
    siteId: row.environment.site.id,
    siteName: row.environment.site.name,
    environmentId: row.environmentId,
    environment: row.environment.kind,
    trigger: row.trigger as VisualCheckTrigger,
    status: row.status as VisualCheckView["status"],
    summary: row.summary,
    maxDiffPercent: row.maxDiffPercent,
    deploymentId: row.deploymentId,
    deploymentTargetId: row.deploymentTargetId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    pages: pageViews(row.pages ?? []),
  };
}

export function toListItem(
  row: Parameters<typeof toCheckView>[0] & { pages: { changed: boolean }[] },
): VisualCheckListItem {
  const view = toCheckView({ ...row, pages: [] });
  return {
    id: view.id,
    siteId: view.siteId,
    siteName: view.siteName,
    environmentId: view.environmentId,
    environment: view.environment,
    trigger: view.trigger,
    status: view.status,
    summary: view.summary,
    maxDiffPercent: view.maxDiffPercent,
    deploymentId: view.deploymentId,
    deploymentTargetId: view.deploymentTargetId,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    pageCount: row.pages.length,
    changedPages: row.pages.filter((p) => p.changed).length,
  };
}

async function persistPages(
  db: Db,
  checkId: string,
  result: VisualCaptureResult,
  mode: "before" | "after" | "once",
): Promise<void> {
  await db.visualPage.deleteMany({ where: { checkId } });
  if (result.pages.length === 0) return;
  await db.visualPage.createMany({
    data: result.pages.map((p) => {
      const hasBefore = mode === "before" || mode === "after" || Boolean(p.beforeFile);
      const hasAfter = mode === "after" || mode === "once" || Boolean(p.afterFile);
      return {
        checkId,
        path: p.path,
        slug: p.slug || visualPageSlug(p.path),
        role: p.role,
        url: p.url,
        ok: p.ok,
        httpStatus: p.status,
        detail: p.detail.slice(0, 500),
        diffPercent: p.diffPercent ?? null,
        changed: Boolean(p.changed),
        hasBefore: mode === "once" ? false : hasBefore,
        hasAfter: mode === "before" ? false : hasAfter,
        hasDiff: Boolean(p.diffFile),
      };
    }),
  });
}

async function notifyVisual(
  deps: VisualDeps,
  input: {
    event: Extract<NotificationEvent, "visual.changed" | "visual.failed">;
    siteId: string;
    siteName: string;
    checkId: string;
    body: string;
  },
): Promise<void> {
  if (!deps.notifier?.notify) return;
  await deps.notifier.notify({
    kind: input.event,
    title:
      input.event === "visual.changed"
        ? `Visual change on ${input.siteName}`
        : `Visual check failed on ${input.siteName}`,
    body: input.body.slice(0, 500),
    severity: "warning",
    siteIds: [input.siteId],
    meta: { checkId: input.checkId },
  });
}

async function runCapture(
  deps: VisualDeps,
  checkId: string,
  env: EnvRow,
  mode: "before" | "after" | "once",
): Promise<VisualCaptureResult> {
  const [settings, health] = await Promise.all([
    readVisualSettings(deps.db),
    readHealthSettings(deps.db),
  ]);
  const pages = buildVisualPages(env.url, env.sshHost, health);
  if (pages.length === 0) {
    return {
      ok: false,
      mode,
      pages: [],
      changed: false,
      detail: "No pages to capture",
      durationMs: 0,
    };
  }
  const raw = await deps.runner.run(
    {
      type: "site.visual.capture",
      checkId,
      mode,
      pages,
      sshHost: env.sshHost,
      viewportWidth: settings.viewportWidth,
      viewportHeight: settings.viewportHeight,
      maxDiffPercent: settings.maxDiffPercent,
      pixelThreshold: settings.pixelThreshold,
    },
    VISUAL_TIMEOUT_MS,
  );
  return VisualCaptureResultSchema.parse(raw);
}

/**
 * Start a before/after check: capture "before" screenshots and leave the row in WAITING.
 * Returns null when visual checks are disabled (caller should skip).
 */
export async function startBeforeVisualCheck(
  deps: VisualDeps,
  env: EnvRow,
  opts: {
    trigger: VisualCheckTrigger;
    deploymentId?: string;
    deploymentTargetId?: string;
    userId?: string | null;
    ip?: string | null;
  },
): Promise<{ checkId: string; skipped: boolean; detail: string }> {
  const now = deps.now;
  const settings = await readVisualSettings(deps.db);
  if (!settings.enabled && opts.trigger !== "manual") {
    return { checkId: "", skipped: true, detail: "Visual checks are off" };
  }

  const check = await deps.db.visualCheck.create({
    data: {
      environmentId: env.id,
      trigger: opts.trigger,
      status: "CAPTURING_BEFORE",
      maxDiffPercent: settings.maxDiffPercent,
      pixelThreshold: settings.pixelThreshold,
      viewportWidth: settings.viewportWidth,
      viewportHeight: settings.viewportHeight,
      deploymentId: opts.deploymentId ?? null,
      deploymentTargetId: opts.deploymentTargetId ?? null,
      requestedById: opts.userId ?? null,
      startedAt: now(),
      summary: "Capturing before screenshots…",
    },
  });

  try {
    const result = await runCapture(deps, check.id, env, "before");
    await persistPages(deps.db, check.id, result, "before");
    if (!result.ok) {
      await deps.db.visualCheck.update({
        where: { id: check.id },
        data: {
          status: "FAILED",
          summary: result.detail.slice(0, 500),
          finishedAt: now(),
        },
      });
      await audit(
        deps.db,
        {
          action: "site.visual.check",
          userId: opts.userId ?? null,
          ip: opts.ip ?? null,
          siteIds: [env.siteId],
          result: "failure",
          meta: {
            checkId: check.id,
            trigger: opts.trigger,
            phase: "before",
            detail: result.detail,
          },
        },
        now(),
      );
      await notifyVisual(deps, {
        event: "visual.failed",
        siteId: env.siteId,
        siteName: env.site.name,
        checkId: check.id,
        body: result.detail,
      });
      return { checkId: check.id, skipped: false, detail: result.detail };
    }
    await deps.db.visualCheck.update({
      where: { id: check.id },
      data: { status: "WAITING", summary: "Before captured — waiting for after" },
    });
    await audit(
      deps.db,
      {
        action: "site.visual.check",
        userId: opts.userId ?? null,
        ip: opts.ip ?? null,
        siteIds: [env.siteId],
        result: "success",
        meta: { checkId: check.id, trigger: opts.trigger, phase: "before" },
      },
      now(),
    );
    return { checkId: check.id, skipped: false, detail: "Before captured" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Visual capture failed";
    await deps.db.visualCheck.update({
      where: { id: check.id },
      data: { status: "FAILED", summary: detail.slice(0, 500), finishedAt: now() },
    });
    await audit(
      deps.db,
      {
        action: "site.visual.check",
        userId: opts.userId ?? null,
        ip: opts.ip ?? null,
        siteIds: [env.siteId],
        result: "failure",
        meta: { checkId: check.id, trigger: opts.trigger, phase: "before", detail },
      },
      now(),
    );
    return { checkId: check.id, skipped: false, detail };
  }
}

/** Capture "after" screenshots, diff, alert on change. No-op when checkId is empty. */
export async function finishAfterVisualCheck(
  deps: VisualDeps,
  env: EnvRow,
  checkId: string,
  opts: { userId?: string | null; ip?: string | null } = {},
): Promise<{ status: string; detail: string }> {
  if (!checkId) return { status: "SKIPPED", detail: "No visual check" };
  const now = deps.now;
  const row = await deps.db.visualCheck.findUnique({ where: { id: checkId } });
  if (!row || row.status !== "WAITING")
    return { status: row?.status ?? "FAILED", detail: "Check is not waiting for after" };

  await deps.db.visualCheck.update({
    where: { id: checkId },
    data: { status: "CAPTURING_AFTER", summary: "Capturing after screenshots…" },
  });

  try {
    const result = await runCapture(deps, checkId, env, "after");
    await persistPages(deps.db, checkId, result, "after");
    const status = !result.ok ? "FAILED" : result.changed ? "CHANGED" : "CLEAN";
    await deps.db.visualCheck.update({
      where: { id: checkId },
      data: {
        status,
        summary: result.detail.slice(0, 500),
        finishedAt: now(),
      },
    });
    await audit(
      deps.db,
      {
        action: "site.visual.check",
        userId: opts.userId ?? null,
        ip: opts.ip ?? null,
        siteIds: [env.siteId],
        result: status === "FAILED" ? "failure" : status === "CHANGED" ? "alert" : "success",
        meta: {
          checkId,
          trigger: row.trigger,
          phase: "after",
          changed: result.changed,
          detail: result.detail,
        },
      },
      now(),
    );
    if (status === "CHANGED")
      await notifyVisual(deps, {
        event: "visual.changed",
        siteId: env.siteId,
        siteName: env.site.name,
        checkId,
        body: result.detail,
      });
    else if (status === "FAILED")
      await notifyVisual(deps, {
        event: "visual.failed",
        siteId: env.siteId,
        siteName: env.site.name,
        checkId,
        body: result.detail,
      });
    void purgeOldChecks(deps).catch(() => undefined);
    return { status, detail: result.detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Visual capture failed";
    await deps.db.visualCheck.update({
      where: { id: checkId },
      data: { status: "FAILED", summary: detail.slice(0, 500), finishedAt: now() },
    });
    return { status: "FAILED", detail };
  }
}

/** Manual "Check now": single after capture (no before), stored for reference. */
export async function runManualVisualCheck(
  deps: VisualDeps,
  env: EnvRow,
  opts: { userId: string; ip?: string | null },
): Promise<{ ok: true; checkId: string } | { ok: false; error: string }> {
  if (env.site.archived) return { ok: false, error: "site_archived" };
  const now = deps.now;
  const settings = await readVisualSettings(deps.db);
  const check = await deps.db.visualCheck.create({
    data: {
      environmentId: env.id,
      trigger: "manual",
      status: "CAPTURING_AFTER",
      maxDiffPercent: settings.maxDiffPercent,
      pixelThreshold: settings.pixelThreshold,
      viewportWidth: settings.viewportWidth,
      viewportHeight: settings.viewportHeight,
      requestedById: opts.userId,
      startedAt: now(),
      summary: "Capturing screenshots…",
    },
  });
  try {
    const result = await runCapture(deps, check.id, env, "once");
    await persistPages(deps.db, check.id, result, "once");
    await deps.db.visualCheck.update({
      where: { id: check.id },
      data: {
        status: result.ok ? "CLEAN" : "FAILED",
        summary: result.detail.slice(0, 500),
        finishedAt: now(),
      },
    });
    await audit(
      deps.db,
      {
        action: "site.visual.check",
        userId: opts.userId,
        ip: opts.ip ?? null,
        siteIds: [env.siteId],
        result: result.ok ? "success" : "failure",
        meta: { checkId: check.id, trigger: "manual", phase: "once", detail: result.detail },
      },
      now(),
    );
    return { ok: true, checkId: check.id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Visual capture failed";
    await deps.db.visualCheck.update({
      where: { id: check.id },
      data: { status: "FAILED", summary: detail.slice(0, 500), finishedAt: now() },
    });
    return { ok: true, checkId: check.id };
  }
}

export async function purgeOldChecks(deps: VisualDeps): Promise<void> {
  const cutoff = new Date(Date.now() - VISUAL_RETENTION_DAYS * 24 * 60 * 60_000);
  const old = await deps.db.visualCheck.findMany({
    where: { finishedAt: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });
  for (const row of old) {
    await deps.store.removeCheck(row.id).catch(() => undefined);
    await deps.db.visualCheck.delete({ where: { id: row.id } }).catch(() => undefined);
  }
  // Also drop orphan folders and cap total disk use.
  await deps.store.purge(VISUAL_RETENTION_DAYS, VISUAL_KEEP_PER_ENV * 40);
}
