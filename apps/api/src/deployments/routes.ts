// Deploy wizard API (Build Order step 10, spec §6.4, screens 9–11).
import {
  CreateDeploymentRequest,
  deploymentNeedsApproval,
  RecordId,
  type CreateDeploymentResponse,
  type DeploymentList,
  DeploymentListQuery,
  type DeploymentView,
} from "@ulixops/shared";
import { type Response, Router } from "express";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Deployment, DeploymentTarget, EnvKind, Site } from "../generated/prisma/client";
import { authorize, clientIpOf, permitted, sessionOf } from "../http/guard";
import { emitApprovalRequested, selfApproveIfAllowed } from "../approvals/routes";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import type { SnapshotStore } from "../snapshots/store";
import { kickDeployment, type OrchestratorDeps } from "./orchestrator";

export interface DeployDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  snapshots: SnapshotStore;
  defaultRetentionDays: number;
  notifier?: SecurityNotifier;
}

type TargetRow = DeploymentTarget & { site: Pick<Site, "id" | "name"> };

export function deploymentsRouter(deps: DeployDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const orch: OrchestratorDeps = deps;
  const canView = authorize("deployments.view", deps);

  function targetView(t: TargetRow) {
    return {
      id: t.id,
      siteId: t.siteId,
      siteName: t.site.name,
      kind: t.kind,
      status: t.status,
      log: t.log,
      backupId: t.backupId,
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    };
  }

  async function deploymentView(
    row: Deployment & {
      pluginVersion: { version: string; plugin: { slug: string; name: string } };
      targets: TargetRow[];
    },
  ): Promise<DeploymentView> {
    const userIds = [row.requestedById, row.approvedById].filter((id): id is string => Boolean(id));
    const users = userIds.length
      ? await db.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      id: row.id,
      status: row.status as DeploymentView["status"],
      pluginSlug: row.pluginVersion.plugin.slug,
      pluginName: row.pluginVersion.plugin.name,
      version: row.pluginVersion.version,
      stagingFirst: row.stagingFirst,
      batchSize: row.batchSize,
      pauseOnFailure: row.pauseOnFailure,
      requestedBy: byId.get(row.requestedById) ?? null,
      approvedBy: row.approvedById ? (byId.get(row.approvedById) ?? null) : null,
      approvalId: row.approvalId,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      targets: row.targets.map(targetView),
    };
  }

  const include = {
    pluginVersion: { include: { plugin: true } },
    targets: {
      include: { site: { select: { id: true, name: true } } },
      orderBy: { id: "asc" as const },
    },
  };

  async function load(
    res: Response,
    idRaw: string | undefined,
  ): Promise<
    | (Deployment & {
        pluginVersion: { version: string; plugin: { slug: string; name: string } };
        targets: TargetRow[];
      })
    | null
  > {
    const id = RecordId.safeParse(idRaw);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    const row = await db.deployment.findUnique({ where: { id: id.data }, include });
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return row;
  }

  router.get("/", canView, async (req, res) => {
    const query = DeploymentListQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { siteId, limit } = query.data;
    const rows = await db.deployment.findMany({
      where: siteId ? { targets: { some: { siteId } } } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      include,
    });
    const deployments = await Promise.all(rows.map((row) => deploymentView(row)));
    const body: DeploymentList = { deployments };
    res.json(body);
  });

  router.get("/:id", canView, async (req, res) => {
    const row = await load(res, typeof req.params.id === "string" ? req.params.id : undefined);
    if (!row) return;
    res.json({ deployment: await deploymentView(row) });
  });

  router.post("/", async (req, res) => {
    const body = CreateDeploymentRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const productionCount = body.data.siteIds.length;
    const needsApproval = deploymentNeedsApproval(productionCount);
    const createPerm = needsApproval ? "deploy.bulk.request" : "deploy.single";
    if (!(await permitted(req, res, createPerm, deps))) return;

    const version = await db.pluginVersion.findFirst({
      where: {
        version: body.data.version,
        plugin: { slug: body.data.pluginSlug },
      },
      include: { plugin: true },
    });
    if (!version) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const sites = await db.site.findMany({
      where: { id: { in: body.data.siteIds }, archived: false },
      include: { environments: true },
    });
    if (sites.length !== body.data.siteIds.length) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    for (const site of sites) {
      const prod = site.environments.find((e) => e.kind === "PRODUCTION");
      if (!prod?.hostKey) {
        res.status(409).json({ error: "connection_untested" });
        return;
      }
      if (body.data.stagingFirst) {
        const staging = site.environments.find((e) => e.kind === "STAGING");
        if (staging && !staging.hostKey) {
          res.status(409).json({ error: "connection_untested" });
          return;
        }
      }
    }

    const targetRows: {
      siteId: string;
      environmentId: string;
      kind: EnvKind;
    }[] = [];
    for (const site of sites) {
      const staging = site.environments.find((e) => e.kind === "STAGING");
      const production = site.environments.find((e) => e.kind === "PRODUCTION");
      if (!production) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (body.data.stagingFirst && staging?.hostKey) {
        targetRows.push({
          siteId: site.id,
          environmentId: staging.id,
          kind: "STAGING",
        });
      }
      targetRows.push({
        siteId: site.id,
        environmentId: production.id,
        kind: "PRODUCTION",
      });
    }

    const deployment = await db.deployment.create({
      data: {
        pluginVersionId: version.id,
        requestedById: user.id,
        stagingFirst: body.data.stagingFirst,
        batchSize: body.data.batchSize,
        pauseOnFailure: body.data.pauseOnFailure,
        status: needsApproval ? "PENDING_APPROVAL" : "QUEUED",
        createdAt: now(),
        targets: { create: targetRows },
      },
      include,
    });

    let approvalId: string | null = null;
    const firstSiteId = body.data.siteIds[0];
    if (needsApproval && firstSiteId) {
      const approval = await db.approvalRequest.create({
        data: {
          action: "deploy.bulk",
          payload: {
            siteId: firstSiteId,
            deploymentId: deployment.id,
            pluginSlug: version.plugin.slug,
            version: version.version,
            siteIds: body.data.siteIds,
            siteCount: productionCount,
          },
          requestedById: user.id,
          status: "PENDING",
          createdAt: now(),
        },
      });
      approvalId = approval.id;
      await db.deployment.update({
        where: { id: deployment.id },
        data: { approvalId },
      });
      await audit(
        db,
        {
          userId: user.id,
          action: "approval.request",
          result: "pending",
          ip: clientIpOf(req),
          siteIds: body.data.siteIds,
          meta: { requestId: approval.id, action: "deploy.bulk", deploymentId: deployment.id },
        },
        now(),
      );
      // A Super Admin approves their own bulk deploy at once; other Admins are alerted (A134).
      const selfApproved = await selfApproveIfAllowed(
        {
          db,
          now,
          notifier: deps.notifier,
          onDeployBulkDecided: (decision, deploymentId, decidedById) =>
            onDeployBulkDecided(orch, decision, deploymentId, decidedById),
        },
        approval.id,
        user,
        clientIpOf(req),
      );
      if (!selfApproved)
        await emitApprovalRequested(db, deps.notifier, {
          requestId: approval.id,
          action: "deploy.bulk",
          summary: `Deploy ${version.plugin.slug} ${version.version} to ${productionCount} production sites`,
          siteIds: body.data.siteIds,
          requestedById: user.id,
        });
      // Unusual activity: bulk deploy requested outside weekday UTC business hours (A95).
      const hour = now().getUTCHours();
      const weekday = now().getUTCDay(); // 0 Sun … 6 Sat
      if (weekday === 0 || weekday === 6 || hour < 7 || hour >= 19) {
        await audit(
          db,
          {
            userId: user.id,
            action: "deployment.out_of_hours",
            result: "alert",
            ip: clientIpOf(req),
            siteIds: body.data.siteIds,
            meta: { deploymentId: deployment.id, approvalId, hourUtc: hour },
          },
          now(),
        );
      }
    }

    await audit(
      db,
      {
        userId: user.id,
        action: "deployment.create",
        result: "success",
        ip: clientIpOf(req),
        siteIds: body.data.siteIds,
        meta: {
          deploymentId: deployment.id,
          pluginSlug: version.plugin.slug,
          version: version.version,
          needsApproval,
          approvalId,
        },
      },
      now(),
    );

    if (!needsApproval) kickDeployment(orch, deployment.id);

    const refreshed = await db.deployment.findUniqueOrThrow({
      where: { id: deployment.id },
      include,
    });
    const response: CreateDeploymentResponse = {
      deployment: await deploymentView(refreshed),
      approvalId,
    };
    res.status(201).json(response);
  });

  router.post("/:id/pause", authorize("deploy.single", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const updated = await db.deployment.updateMany({
      where: { id: id.data, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "PAUSED" },
    });
    if (updated.count !== 1) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    await db.deploymentTarget.updateMany({
      where: { deploymentId: id.data, status: "QUEUED" },
      data: { status: "PAUSED" },
    });
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "deployment.pause",
        result: "success",
        ip: clientIpOf(req),
        meta: { deploymentId: id.data },
      },
      now(),
    );
    const row = await db.deployment.findUniqueOrThrow({ where: { id: id.data }, include });
    res.json({ deployment: await deploymentView(row) });
  });

  router.post("/:id/resume", authorize("deploy.single", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const updated = await db.deployment.updateMany({
      where: { id: id.data, status: "PAUSED" },
      data: { status: "QUEUED" },
    });
    if (updated.count !== 1) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    await db.deploymentTarget.updateMany({
      where: { deploymentId: id.data, status: "PAUSED" },
      data: { status: "QUEUED" },
    });
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "deployment.resume",
        result: "success",
        ip: clientIpOf(req),
        meta: { deploymentId: id.data },
      },
      now(),
    );
    kickDeployment(orch, id.data);
    const row = await db.deployment.findUniqueOrThrow({ where: { id: id.data }, include });
    res.json({ deployment: await deploymentView(row) });
  });

  router.post("/:id/cancel", authorize("deploy.single", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const updated = await db.deployment.updateMany({
      where: {
        id: id.data,
        status: { in: ["QUEUED", "RUNNING", "PAUSED", "PENDING_APPROVAL"] },
      },
      data: { status: "CANCELLED", finishedAt: now() },
    });
    if (updated.count !== 1) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    await db.deploymentTarget.updateMany({
      where: { deploymentId: id.data, status: { in: ["QUEUED", "PAUSED"] } },
      data: { status: "FAILED", finishedAt: now(), log: "Cancelled" },
    });
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "deployment.cancel",
        result: "success",
        ip: clientIpOf(req),
        meta: { deploymentId: id.data },
      },
      now(),
    );
    const row = await db.deployment.findUniqueOrThrow({ where: { id: id.data }, include });
    res.json({ deployment: await deploymentView(row) });
  });

  return router;
}

/** After deploy.bulk is approved: record the approver and start the rollout. */
export async function onDeployBulkDecided(
  deps: OrchestratorDeps,
  decision: "APPROVED" | "REJECTED",
  deploymentId: string,
  decidedById: string,
): Promise<void> {
  if (decision === "APPROVED") {
    await deps.db.deployment.updateMany({
      where: { id: deploymentId, status: "QUEUED" },
      data: { approvedById: decidedById },
    });
    kickDeployment(deps, deploymentId);
    return;
  }
  await deps.db.deployment.updateMany({
    where: { id: deploymentId, status: "PENDING_APPROVAL" },
    data: { status: "CANCELLED", finishedAt: deps.now() },
  });
  await deps.db.deploymentTarget.updateMany({
    where: { deploymentId, status: "QUEUED" },
    data: { status: "FAILED", finishedAt: deps.now(), log: "Approval rejected" },
  });
}
