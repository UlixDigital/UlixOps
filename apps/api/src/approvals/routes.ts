// Approvals (spec screen 12): another Admin approves or rejects; never the requester.
import {
  canDecideApproval,
  DecideApprovalRequest,
  RecordId,
  type ApprovalBulkItemView,
  type ApprovalView,
  versionJumpSafety,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { audit } from "../audit";
import type { Db } from "../db";
import type { ApprovalRequest, Prisma } from "../generated/prisma/client";
import { adminUserIds } from "../notifications/dispatch";
import type { SecurityNotifier } from "../notify";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { APPROVAL_ACTIONS, type ApprovalAction, isApprovalAction } from "./actions";

function bulkItemsFromPayload(payload: unknown): ApprovalBulkItemView[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const out: ApprovalBulkItemView[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.asset !== "plugin" && row.asset !== "theme") continue;
    if (typeof row.name !== "string" || typeof row.version !== "string") continue;
    if (typeof row.updateVersion !== "string") continue;
    const safety =
      row.safety === "patch" ||
      row.safety === "minor" ||
      row.safety === "major" ||
      row.safety === "unknown"
        ? row.safety
        : versionJumpSafety(row.version, row.updateVersion);
    out.push({
      asset: row.asset,
      name: row.name,
      version: row.version,
      updateVersion: row.updateVersion,
      safety,
    });
  }
  return out.length > 0 ? out : undefined;
}

class OutOfDate extends Error {}

export interface ApprovalsDeps {
  db: Db;
  now: () => Date;
  notifier?: SecurityNotifier;
  /**
   * After a deploy.bulk decision is committed: kick the orchestrator on approve, or
   * cancel the waiting deployment on reject (agent decision A82).
   */
  onDeployBulkDecided?: (
    decision: "APPROVED" | "REJECTED",
    deploymentId: string,
    decidedById: string,
  ) => void | Promise<void>;
  /**
   * After site.bulk_update is approved: start the background run (A104/A108).
   * Must not block the HTTP response — long update sequences run after approve returns.
   */
  onBulkUpdateApproved?: (
    payload: unknown,
    decidedById: string,
    requestId: string,
    requesterId: string,
  ) => void | Promise<void>;
}

/** Queues a risky change for a second Admin. One pending request per action and environment. */
export async function requestApproval(
  db: Db,
  input: {
    action: ApprovalAction;
    payload: Prisma.InputJsonObject & { siteId: string; kind: string };
    requestedById: string;
    ip: string | null;
  },
  now: Date,
  notifier?: SecurityNotifier,
): Promise<{ ok: true; id: string } | { ok: false; error: "already_pending" }> {
  const pending = await db.approvalRequest.findFirst({
    where: {
      action: input.action,
      status: "PENDING",
      AND: [
        { payload: { path: ["siteId"], equals: input.payload.siteId } },
        { payload: { path: ["kind"], equals: input.payload.kind } },
      ],
    },
  });
  if (pending) return { ok: false, error: "already_pending" };
  const created = await db.approvalRequest.create({
    data: {
      action: input.action,
      payload: input.payload,
      requestedById: input.requestedById,
      createdAt: now,
    },
  });
  await audit(
    db,
    {
      userId: input.requestedById,
      action: "approval.request",
      result: "pending",
      ip: input.ip,
      siteIds: [input.payload.siteId],
      meta: { requestId: created.id, action: input.action },
    },
    now,
  );
  await emitApprovalRequested(db, notifier, {
    requestId: created.id,
    action: input.action,
    summary: `${input.action} waiting for approval`,
    siteIds: [input.payload.siteId],
    requestedById: input.requestedById,
  });
  return { ok: true, id: created.id };
}

export async function emitApprovalRequested(
  db: Db,
  notifier: SecurityNotifier | undefined,
  input: {
    requestId: string;
    action: string;
    summary: string;
    siteIds: string[];
    requestedById: string;
  },
): Promise<void> {
  if (!notifier?.notify) return;
  const admins = (await adminUserIds(db)).filter((id) => id !== input.requestedById);
  if (admins.length === 0) return;
  await notifier.notify({
    kind: "approval.requested",
    title: "Approval requested",
    body: input.summary,
    severity: "warning",
    siteIds: input.siteIds,
    recipientUserIds: admins,
    meta: { requestId: input.requestId, action: input.action },
  });
}

export function approvalsRouter(deps: ApprovalsDeps): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("approvals.decide", deps));

  async function views(rows: ApprovalRequest[], viewerId: string): Promise<ApprovalView[]> {
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.requestedById, r.decidedById].filter((v): v is string => !!v)),
      ),
    ];
    const users = new Map(
      (
        await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        })
      ).map((u) => [u.id, u]),
    );
    const siteIds = [
      ...new Set(
        rows
          .map((r) => (r.payload as { siteId?: string } | null)?.siteId)
          .filter((v): v is string => !!v),
      ),
    ];
    const sites = new Map(
      (
        await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })
      ).map((s) => [s.id, s.name]),
    );
    return rows.map((row) => {
      let summary = row.action;
      if (isApprovalAction(row.action)) {
        const definition = APPROVAL_ACTIONS[row.action];
        const siteId = definition.siteIdOf(row.payload);
        summary =
          definition.describe(row.payload, (siteId && sites.get(siteId)) || "Deleted site") ??
          row.action;
      }
      const payload = row.payload as { siteId?: string } | null;
      const bulkItems =
        row.action === "site.bulk_update" ? bulkItemsFromPayload(row.payload) : undefined;
      return {
        id: row.id,
        action: row.action,
        status: row.status === "APPROVED" || row.status === "REJECTED" ? row.status : "PENDING",
        summary,
        requestedBy: users.get(row.requestedById) ?? null,
        decidedBy: row.decidedById ? (users.get(row.decidedById) ?? null) : null,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        ownRequest: row.requestedById === viewerId,
        bulkItems,
        siteId: typeof payload?.siteId === "string" ? payload.siteId : null,
      };
    });
  }

  router.get("/", async (req, res) => {
    const viewer = sessionOf(req).user.id;
    const pending = await db.approvalRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    const recent = await db.approvalRequest.findMany({
      where: { status: { not: "PENDING" } },
      orderBy: { decidedAt: "desc" },
      take: 20,
    });
    res.json({ pending: await views(pending, viewer), recent: await views(recent, viewer) });
  });

  async function decide(req: Request, res: Response, decision: "APPROVED" | "REJECTED") {
    const id = RecordId.safeParse(req.params.id);
    const body = DecideApprovalRequest.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const request = await db.approvalRequest.findUnique({ where: { id: id.data } });
    if (!request) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { user } = sessionOf(req);
    const check = canDecideApproval(request, user);
    if (!check.ok) {
      const error = check.reason === "not_admin" ? "forbidden" : check.reason;
      res.status(error === "forbidden" ? 403 : 409).json({ error });
      return;
    }
    const decided = {
      status: decision,
      decidedById: user.id,
      decidedAt: now(),
      comment: body.data.comment || null,
    };
    try {
      await db.$transaction(async (tx) => {
        const claimed = await tx.approvalRequest.updateMany({
          where: { id: request.id, status: "PENDING" },
          data: decided,
        });
        if (claimed.count !== 1) throw new OutOfDate("already decided");
        if (decision === "APPROVED" && isApprovalAction(request.action)) {
          if (!(await APPROVAL_ACTIONS[request.action].apply(tx, request.payload)))
            throw new OutOfDate("site changed");
        }
      });
    } catch (error) {
      if (!(error instanceof OutOfDate)) throw error;
      if (error.message === "already decided") {
        res.status(409).json({ error: "already_decided" });
        return;
      }
      // The site changed since the request: it can't be applied as asked, so it's closed.
      await db.approvalRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          ...decided,
          status: "REJECTED",
          comment: "Out of date: the site changed after this was requested",
        },
      });
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    const payload = request.payload as {
      siteId?: string;
      siteIds?: string[];
      deploymentId?: string;
    } | null;
    const siteIds =
      payload?.siteIds && payload.siteIds.length > 0
        ? payload.siteIds
        : payload?.siteId
          ? [payload.siteId]
          : [];
    await audit(
      db,
      {
        userId: user.id,
        action: decision === "APPROVED" ? "approval.approve" : "approval.reject",
        result: "success",
        ip: clientIpOf(req),
        siteIds,
        meta: {
          requestId: request.id,
          action: request.action,
          requestedById: request.requestedById,
          payload: request.payload as Prisma.InputJsonValue,
        },
      },
      now(),
    );
    if (request.action === "deploy.bulk" && typeof payload?.deploymentId === "string") {
      await deps.onDeployBulkDecided?.(decision, payload.deploymentId, user.id);
    }
    // A108: kick the bulk run in the background so approve never waits on SSH updates.
    if (decision === "APPROVED" && request.action === "site.bulk_update") {
      void Promise.resolve(
        deps.onBulkUpdateApproved?.(request.payload, user.id, request.id, request.requestedById),
      ).catch((error) => {
        console.error(
          JSON.stringify({
            event: "bulk_update_kick_failed",
            requestId: request.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
    res.json({ ok: true });
  }

  router.post("/:id/approve", (req, res) => decide(req, res, "APPROVED"));
  router.post("/:id/reject", (req, res) => decide(req, res, "REJECTED"));
  return router;
}
