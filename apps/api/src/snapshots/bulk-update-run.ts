// Approved / immediate bulk plugin+theme updates with health + rollback (A108).
import { randomUUID } from "node:crypto";
import {
  buildHealthUrls,
  type BulkUpdateItemResult,
  type BulkUpdateRunProgress,
  type BulkUpdateRunStep,
  type BulkUpdateStepName,
  HealthJobResult,
  healthFetchOrigin,
  isMajorVersionBump,
  RemoteCommandResult,
  SiteInventoryResult,
  type SnapshotAsset,
  SnapshotJobResult,
  type VersionJumpSafety,
  versionJumpSafety,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Prisma, Site, SiteEnvironment } from "../generated/prisma/client";
import { readHealthSettings } from "../health/settings";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import { readRetentionDays } from "./retention";
import type { SnapshotStore } from "./store";
import { coreUpdateFields } from "../sites/operations";
import { afterInventoryChange } from "../vulnerabilities/service";
import { finishAfterVisualCheck, startBeforeVisualCheck } from "../visual/service";
import type { VisualStore } from "../visual/store";

const SNAPSHOT_TIMEOUT_MS = 180_000;
// The runner's own cap is 300 s; on top come the SSH Gateway connect and a busy runner queue
// (A136: Elementor timed out here at 330 s while the update itself was still running).
export const UPDATE_TIMEOUT_MS = 420_000;
const HEALTH_TIMEOUT_MS = 90_000;
const INVENTORY_TIMEOUT_MS = 180_000;

export type BulkPlannedItem = {
  asset: SnapshotAsset;
  name: string;
  version: string;
  updateVersion: string;
  safety: VersionJumpSafety;
};

export interface BulkRunDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  snapshots: SnapshotStore;
  defaultRetentionDays: number;
  notifier: SecurityNotifier;
  /** One before/after pair around the whole run (A163). */
  visualStore?: VisualStore;
}

export type EnvPinned = SiteEnvironment & { hostKey: string };

export function targetOf(env: EnvPinned) {
  return {
    host: env.sshHost,
    port: env.sshPort,
    user: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
  };
}

function emptyProgress(items: BulkPlannedItem[], now: Date): BulkUpdateRunProgress {
  return {
    updatedAt: now.toISOString(),
    phase: "pre_health",
    current: null,
    preHealth: null,
    items: items.map((i) => ({
      asset: i.asset,
      name: i.name,
      version: i.version,
      updateVersion: i.updateVersion,
      safety: i.safety,
      outcome: "pending",
      steps: [],
      backupId: null,
    })),
    reportMarkdown: null,
  };
}

function buildReport(opts: {
  siteName: string;
  kind: string;
  preHealth: BulkUpdateRunProgress["preHealth"];
  items: BulkUpdateRunProgress["items"];
  finishedAt: string;
}): string {
  const lines: string[] = [
    `# Bulk update report — ${opts.siteName} (${opts.kind})`,
    "",
    `Finished: ${opts.finishedAt}`,
    "",
    "## Pre-update health",
    opts.preHealth
      ? `- **${opts.preHealth.ok ? "OK" : "FAILED"}** at ${opts.preHealth.checkedAt}: ${opts.preHealth.summary}`
      : "- Not run",
    "",
    "## Items",
  ];
  for (const item of opts.items) {
    lines.push(
      "",
      `### ${item.asset} \`${item.name}\` ${item.version} → ${item.updateVersion} (${item.safety})`,
      `- Outcome: **${item.outcome}**`,
    );
    if (item.backupId) lines.push(`- Snapshot: \`${item.backupId}\``);
    for (const step of item.steps) {
      lines.push(`- ${step.step}: ${step.ok ? "OK" : "FAIL"} — ${step.detail}`);
    }
  }
  const problems = opts.items.filter((i) => i.outcome === "failed" || i.outcome === "rolled_back");
  lines.push("", "## Problems");
  if (problems.length === 0) lines.push("- None");
  else {
    for (const p of problems) {
      const last = p.steps.filter((s) => !s.ok).at(-1);
      lines.push(`- \`${p.name}\`: ${last?.detail ?? p.outcome}`);
    }
  }
  return lines.join("\n");
}

/** One health check with the hub's settings (also used after core updates, A135). */
export async function runHealth(
  deps: Pick<BulkRunDeps, "db" | "runner">,
  env: EnvPinned,
): Promise<{ ok: boolean; summary: string }> {
  const settings = await readHealthSettings(deps.db);
  const origin = healthFetchOrigin(env.url, env.sshHost);
  const urls = buildHealthUrls(origin, settings);
  const raw = await deps.runner.run(
    {
      type: "site.health",
      target: targetOf(env),
      urls,
      origin,
      thresholdMs: settings.thresholdMs,
      checkErrorLog: settings.checkErrorLog,
    },
    HEALTH_TIMEOUT_MS,
  );
  const result = HealthJobResult.parse(raw);
  if (result.hostKeyMismatch) {
    return { ok: false, summary: "SSH host key mismatch — health check refused" };
  }
  return { ok: result.ok, summary: result.summary.slice(0, 1500) };
}

/** Re-read versions and offered updates, store them, re-match vulnerabilities. */
export async function refreshInventory(
  deps: Omit<BulkRunDeps, "snapshots">,
  env: EnvPinned,
  actorUserId: string | null,
): Promise<boolean> {
  const invRaw = await deps.runner.run(
    { type: "site.inventory", target: targetOf(env), checkUpdates: true },
    INVENTORY_TIMEOUT_MS,
  );
  const inv = SiteInventoryResult.parse(invRaw);
  if (inv.hostKeyMismatch) return false;
  const data = {
    refreshedAt: deps.now(),
    refreshedById: actorUserId,
    wpVersion: inv.wpVersion,
    phpVersion: inv.phpVersion,
    wpCliVersion: inv.wpCliVersion,
    activeTheme: inv.themes.find((t) => t.status === "active")?.name ?? null,
    maintenance: inv.maintenance,
    safeMode: inv.safeMode,
    warnings: inv.warnings,
    plugins: inv.plugins,
    themes: inv.themes,
    ...coreUpdateFields(inv, null, deps.now()),
  };
  await deps.db.siteInventory.upsert({
    where: { environmentId: env.id },
    create: { environmentId: env.id, ...data },
    update: data,
  });
  await afterInventoryChange(deps, env.id);
  return true;
}

export async function executeBulkUpdateRun(
  deps: Omit<BulkRunDeps, "snapshots">,
  opts: {
    site: Site;
    env: EnvPinned;
    items: BulkPlannedItem[];
    /** null: the scheduled run (A162). */
    actorUserId: string | null;
    onProgress: (progress: BulkUpdateRunProgress) => Promise<void>;
    /** Unattended runs: stop at the first failure; the rest stay "pending" (A162). */
    stopOnFailure?: boolean;
    /** Unattended runs: don't update a site that is already unhealthy (A162). */
    requireHealthyStart?: boolean;
  },
): Promise<{
  results: BulkUpdateItemResult[];
  progress: BulkUpdateRunProgress;
  inventoryRefreshed: boolean;
  failures: number;
}> {
  const { site, env, items, actorUserId } = opts;
  let progress = emptyProgress(items, deps.now());
  const publish = async () => {
    progress = { ...progress, updatedAt: deps.now().toISOString() };
    await opts.onProgress(progress);
  };

  await publish();

  // Pre-update health (still proceed if unhealthy — report records it).
  let preOk = false;
  let preSummary: string;
  try {
    const health = await runHealth(deps, env);
    preOk = health.ok;
    preSummary = health.summary;
  } catch (error) {
    preSummary = error instanceof Error ? error.message.slice(0, 500) : "Health check failed";
  }
  progress = {
    ...progress,
    phase: "items",
    preHealth: { ok: preOk, summary: preSummary, checkedAt: deps.now().toISOString() },
  };
  await publish();

  let visualCheckId = "";
  if (deps.visualStore) {
    try {
      const before = await startBeforeVisualCheck(
        {
          db: deps.db,
          runner: deps.runner,
          store: deps.visualStore,
          notifier: deps.notifier,
          now: deps.now,
        },
        {
          id: env.id,
          kind: env.kind,
          url: env.url,
          sshHost: env.sshHost,
          siteId: site.id,
          site: { id: site.id, name: site.name, archived: site.archived },
        },
        {
          trigger: actorUserId === null ? "autoupdate" : "update",
          userId: actorUserId,
        },
      );
      if (!before.skipped) visualCheckId = before.checkId;
    } catch {
      // Visual is best-effort; never block the update run.
    }
  }

  const results: BulkUpdateItemResult[] = [];
  let failures = 0;
  const days = await readRetentionDays(deps.db, deps.defaultRetentionDays);

  for (let index = 0; index < items.length; index++) {
    if (opts.requireHealthyStart && !preOk) break;
    if (opts.stopOnFailure && failures > 0) break;
    const item = items[index];
    const itemProgress = progress.items[index];
    if (!item || !itemProgress) continue;
    itemProgress.outcome = "running";
    const pushStep = async (step: BulkUpdateStepName, ok: boolean, detail: string) => {
      const row: BulkUpdateRunStep = {
        step,
        ok,
        detail: detail.slice(0, 2000),
        at: deps.now().toISOString(),
      };
      itemProgress.steps.push(row);
      progress = {
        ...progress,
        current: {
          index,
          total: items.length,
          asset: item.asset,
          name: item.name,
          step,
        },
      };
      await publish();
    };

    const includeDb = isMajorVersionBump(item.version, item.updateVersion);
    const expiresAt = new Date(deps.now().getTime() + days * 86_400_000);
    const row = await deps.db.backup.create({
      data: {
        siteId: site.id,
        environmentId: env.id,
        kind: "QUICK_SNAPSHOT",
        status: "PENDING",
        pluginName: item.name,
        includesDb: includeDb,
        location: "pending",
        encrypted: true,
        expiresAt,
        createdById: actorUserId,
        createdAt: deps.now(),
      },
    });

    const backupId: string | null = row.id;
    let snapshotOk = false;
    try {
      progress.current = {
        index,
        total: items.length,
        asset: item.asset,
        name: item.name,
        step: "snapshot",
      };
      await publish();
      const raw = await deps.runner.run(
        {
          type: "site.snapshot",
          target: targetOf(env),
          backupId: row.id,
          plugin: item.name,
          includeDb,
          asset: item.asset,
        },
        SNAPSHOT_TIMEOUT_MS,
      );
      const snap = SnapshotJobResult.parse(raw);
      if (!snap.hostKeyMismatch && snap.ok && snap.sha256 && snap.location) {
        await deps.db.backup.update({
          where: { id: row.id },
          data: {
            status: "READY",
            pluginVersion: snap.pluginVersion,
            includesDb: snap.includesDb,
            sha256: snap.sha256,
            sizeBytes: snap.sizeBytes,
            location: snap.location,
          },
        });
        snapshotOk = true;
        itemProgress.backupId = row.id;
        await pushStep("snapshot", true, snap.detail || `Snapshot ready (${snap.pluginVersion})`);
      } else {
        await deps.db.backup.update({ where: { id: row.id }, data: { status: "FAILED" } });
        const detail = snap.hostKeyMismatch
          ? "SSH host key mismatch"
          : snap.detail || "Snapshot failed";
        await pushStep("snapshot", false, detail);
      }
    } catch (error) {
      await deps.db.backup.update({ where: { id: row.id }, data: { status: "FAILED" } });
      await pushStep(
        "snapshot",
        false,
        error instanceof Error ? error.message.slice(0, 500) : "Snapshot failed",
      );
    }

    if (!snapshotOk) {
      failures += 1;
      itemProgress.outcome = "failed";
      results.push({
        asset: item.asset,
        name: item.name,
        status: "failed",
        detail: itemProgress.steps.at(-1)?.detail || "Snapshot failed",
        backupId,
        fromVersion: item.version,
        toVersion: item.updateVersion,
        safety: item.safety,
      });
      await publish();
      continue;
    }

    let updateOk = false;
    try {
      progress.current = {
        index,
        total: items.length,
        asset: item.asset,
        name: item.name,
        step: "update",
      };
      await publish();
      const updated = await deps.runner.run(
        {
          type: "remote.command",
          target: targetOf(env),
          command: {
            op: item.asset === "theme" ? "theme.update" : "plugin.update",
            slug: item.name,
          },
        },
        UPDATE_TIMEOUT_MS,
      );
      const cmd = RemoteCommandResult.safeParse(updated);
      if (cmd.success && !cmd.data.hostKeyMismatch && cmd.data.exitCode === 0) {
        updateOk = true;
        await pushStep(
          "update",
          true,
          [cmd.data.stdout.trim(), cmd.data.stderr.trim()].filter(Boolean).join("\n") ||
            `Updated to ${item.updateVersion}`,
        );
      } else {
        let detail = "Update failed";
        if (cmd.success && cmd.data.hostKeyMismatch) detail = "SSH host key mismatch";
        else if (cmd.success && !cmd.data.hostKeyMismatch) {
          detail =
            [cmd.data.stdout.trim(), cmd.data.stderr.trim()].filter(Boolean).join("\n") ||
            `Update exit ${cmd.data.exitCode}`;
        }
        await pushStep("update", false, detail);
      }
    } catch (error) {
      await pushStep(
        "update",
        false,
        error instanceof Error ? error.message.slice(0, 500) : "Update failed",
      );
    }

    if (!updateOk) {
      failures += 1;
      itemProgress.outcome = "failed";
      results.push({
        asset: item.asset,
        name: item.name,
        status: "failed",
        detail: itemProgress.steps.at(-1)?.detail || "Update failed",
        backupId,
        fromVersion: item.version,
        toVersion: item.updateVersion,
        safety: item.safety,
      });
      await publish();
      continue;
    }

    // Post-update health; roll back this item on failure.
    let healthOk = false;
    let healthSummary: string;
    try {
      progress.current = {
        index,
        total: items.length,
        asset: item.asset,
        name: item.name,
        step: "health",
      };
      await publish();
      const health = await runHealth(deps, env);
      healthOk = health.ok;
      healthSummary = health.summary;
      await pushStep("health", health.ok, health.summary);
      await deps.db.siteEnvironment.update({
        where: { id: env.id },
        data: {
          lastHealthAt: deps.now(),
          lastHealthOk: health.ok,
          lastHealthSummary: health.summary.slice(0, 500),
        },
      });
    } catch (error) {
      healthSummary = error instanceof Error ? error.message.slice(0, 500) : "Health check failed";
      await pushStep("health", false, healthSummary);
    }

    if (healthOk) {
      itemProgress.outcome = "succeeded";
      results.push({
        asset: item.asset,
        name: item.name,
        status: "succeeded",
        detail: `Updated ${item.version} → ${item.updateVersion}; health OK`,
        backupId,
        fromVersion: item.version,
        toVersion: item.updateVersion,
        safety: item.safety,
      });
      await publish();
      continue;
    }

    // Auto-rollback from the snapshot we just took.
    let rolledBack = false;
    try {
      progress.current = {
        index,
        total: items.length,
        asset: item.asset,
        name: item.name,
        step: "rollback",
      };
      await publish();
      const backup = await deps.db.backup.findUniqueOrThrow({ where: { id: row.id } });
      if (backup.status === "READY" && backup.location !== "pending") {
        const raw = await deps.runner.run(
          {
            type: "site.snapshot.restore",
            target: targetOf(env),
            backupId: backup.id,
            plugin: item.name,
            includesDb: backup.includesDb,
            location: backup.location,
            asset: item.asset,
          },
          SNAPSHOT_TIMEOUT_MS,
        );
        const restored = SnapshotJobResult.parse(raw);
        rolledBack = !restored.hostKeyMismatch && restored.ok;
        const rollbackDetail = restored.hostKeyMismatch
          ? "SSH host key mismatch"
          : restored.detail || (rolledBack ? "Restored snapshot" : "Rollback failed");
        await pushStep("rollback", rolledBack, rollbackDetail);
      } else {
        await pushStep("rollback", false, "No READY snapshot to restore");
      }
    } catch (error) {
      await pushStep(
        "rollback",
        false,
        error instanceof Error ? error.message.slice(0, 500) : "Rollback failed",
      );
    }

    failures += 1;
    itemProgress.outcome = rolledBack ? "rolled_back" : "failed";
    results.push({
      asset: item.asset,
      name: item.name,
      status: rolledBack ? "rolled_back" : "failed",
      detail: rolledBack
        ? `Health failed after update (${healthSummary}); rolled back to ${item.version}`
        : `Health failed after update (${healthSummary}); rollback failed`,
      backupId,
      fromVersion: item.version,
      toVersion: item.updateVersion,
      safety: item.safety,
      rolledBack,
    });
    await publish();
  }

  let inventoryRefreshed = false;
  try {
    inventoryRefreshed = await refreshInventory(deps, env, actorUserId);
  } catch {
    // best-effort
  }

  if (visualCheckId && deps.visualStore) {
    try {
      await finishAfterVisualCheck(
        {
          db: deps.db,
          runner: deps.runner,
          store: deps.visualStore,
          notifier: deps.notifier,
          now: deps.now,
        },
        {
          id: env.id,
          kind: env.kind,
          url: env.url,
          sshHost: env.sshHost,
          siteId: site.id,
          site: { id: site.id, name: site.name, archived: site.archived },
        },
        visualCheckId,
        { userId: actorUserId },
      );
    } catch {
      // best-effort
    }
  }

  const finishedAt = deps.now().toISOString();
  const reportMarkdown = buildReport({
    siteName: site.name,
    kind: env.kind,
    preHealth: progress.preHealth,
    items: progress.items,
    finishedAt,
  });
  progress = {
    ...progress,
    phase: "done",
    current: null,
    reportMarkdown,
    updatedAt: finishedAt,
  };
  await opts.onProgress(progress);

  return { results, progress, inventoryRefreshed, failures };
}

export async function patchApprovalProgress(
  db: Db,
  requestId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!row) return;
  const prev =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  await db.approvalRequest.update({
    where: { id: requestId },
    data: { payload: { ...prev, ...patch } as Prisma.InputJsonValue },
  });
}

/**
 * After an API restart, in-process bulk runs are gone but ApprovalRequest + env locks remain.
 * Mark those runs failed and drop every env lock (single API instance — A110).
 */
export async function recoverOrphanedBulkUpdates(
  db: Db,
  now: () => Date,
): Promise<{ markedFailed: number; locksCleared: number }> {
  const rows = await db.approvalRequest.findMany({
    where: {
      action: "site.bulk_update",
      status: "APPROVED",
    },
    select: { id: true, payload: true },
  });
  let markedFailed = 0;
  const finishedAt = now().toISOString();
  for (const row of rows) {
    const payload =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const runStatus = payload.runStatus;
    if (runStatus !== "queued" && runStatus !== "running") continue;
    await db.approvalRequest.update({
      where: { id: row.id },
      data: {
        payload: {
          ...payload,
          runStatus: "failed",
          runDetail: "interrupted_by_restart",
          runFinishedAt: finishedAt,
        } as Prisma.InputJsonValue,
      },
    });
    markedFailed += 1;
  }
  const cleared = await db.siteEnvironmentLock.deleteMany({});
  if (markedFailed > 0 || cleared.count > 0) {
    console.warn(
      JSON.stringify({
        event: "bulk_update_orphan_recovery",
        markedFailed,
        locksCleared: cleared.count,
      }),
    );
  }
  return { markedFailed, locksCleared: cleared.count };
}

/** Background entry after site.bulk_update is approved (A108). */
export async function onBulkUpdateApproved(
  deps: BulkRunDeps,
  payload: {
    siteId: string;
    kind: string;
    items: {
      asset: SnapshotAsset;
      name: string;
      version: string;
      updateVersion: string;
      safety?: VersionJumpSafety;
    }[];
  },
  decidedById: string,
  requestId: string,
  requesterId: string | null,
): Promise<void> {
  const site = await deps.db.site.findUnique({
    where: { id: payload.siteId },
    include: { environments: true },
  });
  const env = site?.environments.find((e) => e.kind === payload.kind);
  if (!site || !env?.hostKey || site.archived) {
    await patchApprovalProgress(deps.db, requestId, {
      runStatus: "failed",
      runDetail: "site_unavailable",
    });
    return;
  }

  const token = randomUUID();
  try {
    await deps.db.siteEnvironmentLock.create({
      data: { environmentId: env.id, token, lockedAt: deps.now() },
    });
  } catch {
    await patchApprovalProgress(deps.db, requestId, {
      runStatus: "failed",
      runDetail: "site_busy",
    });
    return;
  }

  await patchApprovalProgress(deps.db, requestId, { runStatus: "running" });

  const planned: BulkPlannedItem[] = payload.items.map((i) => ({
    asset: i.asset,
    name: i.name,
    version: i.version,
    updateVersion: i.updateVersion,
    safety: i.safety ?? versionJumpSafety(i.version, i.updateVersion),
  }));

  try {
    const { failures, progress } = await executeBulkUpdateRun(deps, {
      site,
      env: env as EnvPinned,
      items: planned,
      actorUserId: decidedById,
      onProgress: async (p) => {
        // Keep the env lock fresh so SITE_JOB_STALE_MS takeover cannot steal a long run (A110).
        await deps.db.siteEnvironmentLock.updateMany({
          where: { environmentId: env.id, token },
          data: { lockedAt: deps.now() },
        });
        await patchApprovalProgress(deps.db, requestId, { runProgress: p });
      },
    });
    const runStatus = failures === 0 ? "completed" : "failed";
    await patchApprovalProgress(deps.db, requestId, {
      runStatus,
      runFinishedAt: deps.now().toISOString(),
      runFailures: failures,
      reportMarkdown: progress.reportMarkdown,
      runProgress: progress,
    });

    await audit(
      deps.db,
      {
        userId: decidedById,
        action: "site.bulk_update.run",
        result: failures === 0 ? "success" : "failure",
        ip: null,
        siteIds: [site.id],
        meta: {
          kind: payload.kind,
          count: planned.length,
          failures,
          requestId,
        },
      },
      deps.now(),
    );

    const recipients = [...new Set([decidedById, requesterId].filter((v): v is string => !!v))];
    const kind =
      failures === 0 ? ("bulk_update.completed" as const) : ("bulk_update.failed" as const);
    await deps.notifier.notify?.({
      kind,
      title:
        failures === 0
          ? `Bulk update finished on ${site.name}`
          : `Bulk update had failures on ${site.name}`,
      body:
        failures === 0
          ? `All ${planned.length} item(s) updated on ${payload.kind}.`
          : `${failures} of ${planned.length} item(s) failed or were rolled back on ${payload.kind}. Open the site plugins page for the report.`,
      severity: failures === 0 ? "info" : "warning",
      recipientUserIds: recipients,
      siteIds: [site.id],
      meta: { requestId, failures, count: planned.length },
    });
  } catch (error) {
    await patchApprovalProgress(deps.db, requestId, {
      runStatus: "failed",
      runDetail: error instanceof Error ? error.message.slice(0, 500) : "run_failed",
    });
    const recipients = [...new Set([decidedById, requesterId].filter((v): v is string => !!v))];
    await deps.notifier.notify?.({
      kind: "bulk_update.failed",
      title: `Bulk update crashed on ${site.name}`,
      body: error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure",
      severity: "critical",
      recipientUserIds: recipients,
      siteIds: [site.id],
      meta: { requestId },
    });
  } finally {
    await deps.db.siteEnvironmentLock.deleteMany({ where: { environmentId: env.id, token } });
  }
}
