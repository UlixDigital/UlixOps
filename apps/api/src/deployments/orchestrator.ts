// Runs a deployment through snapshot → deploy → health → optional rollback (spec §6.4).
import { randomUUID } from "node:crypto";
import {
  buildHealthUrls,
  healthFetchOrigin,
  HealthJobResult,
  PluginDeployResult,
  SITE_JOB_STALE_MS,
  SnapshotJobResult,
  type TargetStatus,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type { SiteEnvironment } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import { readHealthSettings } from "../health/settings";
import { adminUserIds } from "../notifications/dispatch";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import { RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { readRetentionDays } from "../snapshots/retention";
import type { SnapshotStore } from "../snapshots/store";

const SNAPSHOT_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 120_000;

export interface OrchestratorDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  snapshots: SnapshotStore;
  defaultRetentionDays: number;
  notifier?: SecurityNotifier;
}

const running = new Set<string>();

/** Start background processing if the deployment is QUEUED / RUNNING and not already looping. */
export function kickDeployment(deps: OrchestratorDeps, deploymentId: string): void {
  if (running.has(deploymentId)) return;
  running.add(deploymentId);
  void processDeployment(deps, deploymentId).finally(() => running.delete(deploymentId));
}

async function processDeployment(deps: OrchestratorDeps, deploymentId: string): Promise<void> {
  const { db, now } = deps;
  try {
    for (;;) {
      const deployment = await db.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          pluginVersion: { include: { plugin: true } },
          targets: { include: { environment: true, site: true }, orderBy: { id: "asc" } },
        },
      });
      if (!deployment) return;
      if (
        deployment.status === "PENDING_APPROVAL" ||
        deployment.status === "PAUSED" ||
        deployment.status === "CANCELLED" ||
        deployment.status === "SUCCEEDED" ||
        deployment.status === "FAILED"
      ) {
        return;
      }

      if (deployment.status === "QUEUED") {
        const firstStart = !deployment.startedAt;
        await db.deployment.update({
          where: { id: deploymentId },
          data: { status: "RUNNING", startedAt: deployment.startedAt ?? now() },
        });
        if (firstStart) {
          await emitDeploy(deps, {
            kind: "deployment.started",
            title: `Deployment started: ${deployment.pluginVersion.plugin.name} ${deployment.pluginVersion.version}`,
            body: `${deployment.targets.length} target(s)`,
            severity: "info",
            deploymentId,
            requestedById: deployment.requestedById,
            siteIds: [...new Set(deployment.targets.map((t) => t.siteId))],
          });
        }
      }

      const stagingTargets = deployment.targets.filter((t) => t.kind === "STAGING");
      const productionTargets = deployment.targets.filter((t) => t.kind === "PRODUCTION");
      // Finish every non-terminal staging target before any production (spec §6.4).
      const stagingIncomplete = stagingTargets.some((t) => !isTerminal(t.status));
      const phase = stagingIncomplete ? stagingTargets : productionTargets;

      const nextBatch = phase.filter((t) => !isTerminal(t.status)).slice(0, deployment.batchSize);
      if (nextBatch.length === 0) {
        const allDone = deployment.targets.every((t) => isTerminal(t.status));
        if (allDone) {
          const failed = deployment.targets.some(
            (t) => t.status === "FAILED" || t.status === "ROLLED_BACK",
          );
          await db.deployment.update({
            where: { id: deploymentId },
            data: {
              status: failed ? "FAILED" : "SUCCEEDED",
              finishedAt: now(),
            },
          });
          const siteIds = [...new Set(deployment.targets.map((t) => t.siteId))];
          if (failed) {
            await emitDeploy(deps, {
              kind: "deployment.failed",
              title: `Deployment failed: ${deployment.pluginVersion.plugin.name} ${deployment.pluginVersion.version}`,
              body: "One or more targets failed or rolled back. Open Deployments for details.",
              severity: "critical",
              deploymentId,
              requestedById: deployment.requestedById,
              siteIds,
            });
          } else {
            await emitDeploy(deps, {
              kind: "deployment.succeeded",
              title: `Deployment finished: ${deployment.pluginVersion.plugin.name} ${deployment.pluginVersion.version}`,
              body: `All ${deployment.targets.length} target(s) succeeded.`,
              severity: "info",
              deploymentId,
              requestedById: deployment.requestedById,
              siteIds,
            });
          }
        }
        return;
      }

      for (const target of nextBatch) {
        const fresh = await db.deployment.findUnique({ where: { id: deploymentId } });
        if (!fresh || fresh.status === "PAUSED" || fresh.status === "CANCELLED") return;

        const outcome = await runTarget(deps, {
          deploymentId,
          targetId: target.id,
          plugin: deployment.pluginVersion.plugin.slug,
          storageKey: deployment.pluginVersion.storageKey,
          sha256: deployment.pluginVersion.sha256,
          includeDb: deployment.pluginVersion.dbChanging,
          env: target.environment,
          siteId: target.siteId,
        });

        if (!outcome.ok && deployment.pauseOnFailure) {
          await db.deployment.update({
            where: { id: deploymentId },
            data: { status: "PAUSED" },
          });
          await db.deploymentTarget.updateMany({
            where: { deploymentId, status: "QUEUED" },
            data: { status: "PAUSED" },
          });
          if (outcome.rolledBack) {
            await emitDeploy(deps, {
              kind: "deployment.rolled_back",
              title: `Automatic rollback: ${deployment.pluginVersion.plugin.name} ${deployment.pluginVersion.version}`,
              body: "Health check failed after deploy; the site was rolled back and the rollout paused.",
              severity: "warning",
              deploymentId,
              requestedById: deployment.requestedById,
              siteIds: [target.siteId],
            });
          } else {
            await emitDeploy(deps, {
              kind: "deployment.failed",
              title: `Deployment paused after failure: ${deployment.pluginVersion.plugin.name} ${deployment.pluginVersion.version}`,
              body: "A target failed; remaining sites are paused.",
              severity: "critical",
              deploymentId,
              requestedById: deployment.requestedById,
              siteIds: [target.siteId],
            });
          }
          return;
        }
      }
    }
  } catch (error) {
    console.error(
      `deploy: orchestrator failed for ${deploymentId}: ${error instanceof Error ? error.name : typeof error}`,
    );
    await db.deployment.updateMany({
      where: { id: deploymentId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", finishedAt: now() },
    });
  }
}

function isTerminal(status: TargetStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "ROLLED_BACK";
}

async function runTarget(
  deps: OrchestratorDeps,
  opts: {
    deploymentId: string;
    targetId: string;
    plugin: string;
    storageKey: string;
    sha256: string;
    includeDb: boolean;
    env: SiteEnvironment;
    siteId: string;
  },
): Promise<{ ok: boolean; rolledBack?: boolean }> {
  const { db, now, runner } = deps;
  const logs: string[] = [];
  const append = async (line: string, status?: TargetStatus) => {
    logs.push(line);
    await db.deploymentTarget.update({
      where: { id: opts.targetId },
      data: {
        log: logs.join("\n").slice(0, 50_000),
        ...(status ? { status } : {}),
      },
    });
  };

  if (!opts.env.hostKey) {
    await append("Skipped: host key not pinned. Run Test connection first.", "FAILED");
    await db.deploymentTarget.update({
      where: { id: opts.targetId },
      data: { finishedAt: now() },
    });
    return { ok: false };
  }

  const env = opts.env as SiteEnvironment & { hostKey: string };
  const target = {
    host: env.sshHost,
    port: env.sshPort,
    user: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
  };

  await db.deploymentTarget.update({
    where: { id: opts.targetId },
    data: { startedAt: now(), status: "SNAPSHOT" },
  });
  await append("Taking quick snapshot…", "SNAPSHOT");

  const token = await claim(db, env.id, now);
  if (!token) {
    await append("Environment busy; could not claim lock.", "FAILED");
    await db.deploymentTarget.update({
      where: { id: opts.targetId },
      data: { finishedAt: now() },
    });
    return { ok: false };
  }

  try {
    const days = await readRetentionDays(db, deps.defaultRetentionDays);
    const backup = await db.backup.create({
      data: {
        siteId: opts.siteId,
        environmentId: env.id,
        kind: "QUICK_SNAPSHOT",
        status: "PENDING",
        pluginName: opts.plugin,
        includesDb: opts.includeDb,
        location: "pending",
        encrypted: true,
        expiresAt: new Date(now().getTime() + days * 86_400_000),
        createdAt: now(),
      },
    });
    try {
      const snapRaw = await runner.run(
        {
          type: "site.snapshot",
          target,
          backupId: backup.id,
          plugin: opts.plugin,
          includeDb: opts.includeDb,
        },
        SNAPSHOT_TIMEOUT_MS,
      );
      const snap = SnapshotJobResult.parse(snapRaw);
      if (snap.hostKeyMismatch || !snap.ok || !snap.sha256 || !snap.location) {
        await db.backup.update({ where: { id: backup.id }, data: { status: "FAILED" } });
        await append(
          snap.hostKeyMismatch
            ? "Snapshot refused: host key mismatch."
            : `Snapshot failed: ${"detail" in snap ? snap.detail : "unknown"}`,
          "FAILED",
        );
        await db.deploymentTarget.update({
          where: { id: opts.targetId },
          data: { finishedAt: now() },
        });
        return { ok: false };
      }
      await db.backup.update({
        where: { id: backup.id },
        data: {
          status: "READY",
          pluginVersion: snap.pluginVersion,
          includesDb: snap.includesDb,
          sha256: snap.sha256,
          sizeBytes: snap.sizeBytes,
          location: snap.location,
        },
      });
      await db.deploymentTarget.update({
        where: { id: opts.targetId },
        data: { backupId: backup.id },
      });
      await append(`Snapshot ready (${backup.id}).`);
    } catch (error) {
      await db.backup.update({ where: { id: backup.id }, data: { status: "FAILED" } });
      await append(`Snapshot error: ${errorMessage(error)}`, "FAILED");
      await db.deploymentTarget.update({
        where: { id: opts.targetId },
        data: { finishedAt: now() },
      });
      return { ok: false };
    }

    await append("Deploying plugin ZIP…", "DEPLOYING");
    try {
      const deployRaw = await runner.run(
        {
          type: "site.plugin.deploy",
          target,
          plugin: opts.plugin,
          storageKey: opts.storageKey,
          sha256: opts.sha256,
        },
        DEPLOY_TIMEOUT_MS,
      );
      const deployed = PluginDeployResult.parse(deployRaw);
      if (deployed.hostKeyMismatch || !deployed.ok) {
        await append(
          deployed.hostKeyMismatch
            ? "Deploy refused: host key mismatch."
            : `Deploy failed: ${"detail" in deployed ? deployed.detail : "unknown"}`,
          "FAILED",
        );
        await db.deploymentTarget.update({
          where: { id: opts.targetId },
          data: { finishedAt: now() },
        });
        return { ok: false };
      }
      await append(deployed.detail);
    } catch (error) {
      await append(`Deploy error: ${errorMessage(error)}`, "FAILED");
      await db.deploymentTarget.update({
        where: { id: opts.targetId },
        data: { finishedAt: now() },
      });
      return { ok: false };
    }

    await append("Running health check…", "CHECKING");
    const settings = await readHealthSettings(db);
    let healthOk = false;
    try {
      const origin = healthFetchOrigin(env.url, env.sshHost);
      const urls = buildHealthUrls(origin, settings.extraPaths);
      const healthRaw = await runner.run(
        {
          type: "site.health",
          target,
          urls,
          origin,
          thresholdMs: settings.thresholdMs,
          checkErrorLog: settings.checkErrorLog,
        },
        HEALTH_TIMEOUT_MS,
      );
      const health = HealthJobResult.parse(healthRaw);
      if (health.hostKeyMismatch) {
        await append("Health check refused: host key mismatch.", "FAILED");
      } else {
        await db.siteEnvironment.update({
          where: { id: env.id },
          data: {
            lastHealthAt: now(),
            lastHealthOk: health.ok,
            lastHealthSummary: health.summary.slice(0, 500),
          },
        });
        healthOk = health.ok;
        await append(health.summary);
      }
    } catch (error) {
      await append(`Health check error: ${errorMessage(error)}`);
      healthOk = false;
    }

    if (healthOk) {
      await append("Healthy. Done.", "DONE");
      await db.deploymentTarget.update({
        where: { id: opts.targetId },
        data: { finishedAt: now() },
      });
      return { ok: true };
    }

    await append("Unhealthy — rolling back snapshot…", "CHECKING");
    try {
      const readyBackup = await db.backup.findUniqueOrThrow({ where: { id: backup.id } });
      const restoreRaw = await runner.run(
        {
          type: "site.snapshot.restore",
          target,
          backupId: backup.id,
          plugin: opts.plugin,
          includesDb: opts.includeDb,
          location: readyBackup.location !== "pending" ? readyBackup.location : undefined,
        },
        RESTORE_TIMEOUT_MS,
      );
      const restored = SnapshotJobResult.parse(restoreRaw);
      if (restored.hostKeyMismatch || !restored.ok) {
        await append(
          restored.hostKeyMismatch
            ? "Rollback refused: host key mismatch."
            : `Rollback failed: ${"detail" in restored ? restored.detail : "unknown"}`,
          "FAILED",
        );
      } else {
        await append(`Rolled back: ${restored.detail}`, "ROLLED_BACK");
      }
    } catch (error) {
      await append(`Rollback error: ${errorMessage(error)}`, "FAILED");
    }
    const rolledBack = logs.some((line) => line.startsWith("Rolled back:"));
    await db.deploymentTarget.update({
      where: { id: opts.targetId },
      data: { finishedAt: now() },
    });
    return { ok: false, rolledBack };
  } finally {
    await release(db, env.id, token);
  }
}

async function emitDeploy(
  deps: OrchestratorDeps,
  input: {
    kind:
      | "deployment.started"
      | "deployment.succeeded"
      | "deployment.failed"
      | "deployment.rolled_back";
    title: string;
    body: string;
    severity: "info" | "warning" | "critical";
    deploymentId: string;
    requestedById: string;
    siteIds: string[];
  },
): Promise<void> {
  // System-driven outcomes still need an AuditLog row (CLAUDE.md / SPEC §5, A92).
  await audit(
    deps.db,
    {
      userId: input.requestedById,
      action: input.kind,
      result:
        input.kind === "deployment.succeeded"
          ? "success"
          : input.kind === "deployment.rolled_back"
            ? "alert"
            : "failure",
      siteIds: input.siteIds,
      meta: { deploymentId: input.deploymentId, title: input.title },
    },
    deps.now(),
  );
  if (!deps.notifier?.notify) return;
  const admins = await adminUserIds(deps.db);
  await deps.notifier.notify({
    kind: input.kind,
    title: input.title,
    body: input.body,
    severity: input.severity,
    siteIds: input.siteIds,
    recipientUserIds: [...new Set([...admins, input.requestedById])],
    meta: { deploymentId: input.deploymentId },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof RunnerUnavailableError) return "Runner did not answer in time";
  if (error instanceof RunnerJobFailedError) return error.message.slice(0, 300);
  if (error instanceof Error) return error.message.slice(0, 300);
  return "Unknown error";
}

async function claim(db: Db, environmentId: string, now: () => Date): Promise<string | null> {
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

const release = (db: Db, environmentId: string, token: string) =>
  db.siteEnvironmentLock.deleteMany({ where: { environmentId, token } });
