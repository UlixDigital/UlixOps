// Approvals (spec screen 12): another Admin approves or rejects; never the requester.
import {
  can,
  canDecideApproval,
  DecideApprovalRequest,
  RecordId,
  type ApprovalBulkItemView,
  type ApprovalView,
  type RoleName,
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
  /** After a site.backup.restore decision: start it, or close the request (A152). */
  onRestoreDecided?: (
    decision: "APPROVED" | "REJECTED",
    restoreId: string,
    decidedById: string,
  ) => void | Promise<void>;
  /** After a site.debuglog.bulk approval: switch logging on, one site at a time (A160). */
  onDebugLogBulkApproved?: (
    environmentIds: string[],
    requestedById: string,
  ) => void | Promise<void>;
  /** After a dns.rollback decision: run it, or close it (A156). */
  onDnsRollbackDecided?: (
    decision: "APPROVED" | "REJECTED",
    rollbackId: string,
    decidedById: string,
  ) => void | Promise<void>;
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
    /** A Super Admin self-approves right after (A134), so don't ask the other Admins. */
    requesterRole?: RoleName;
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
      siteIds: input.payload.siteId ? [input.payload.siteId] : [],
      meta: { requestId: created.id, action: input.action },
    },
    now,
  );
  if (input.requesterRole && can(input.requesterRole, "approvals.self"))
    return { ok: true, id: created.id };
  await emitApprovalRequested(db, notifier, {
    requestId: created.id,
    action: input.action,
    summary: `${input.action} waiting for approval`,
    siteIds: input.payload.siteId ? [input.payload.siteId] : [],
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
    scope: input.requestId,
  });
}

export function approvalsRouter(deps: ApprovalsDeps): Router {
  const { db } = deps;
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
        siteId: typeof payload?.siteId === "string" && payload.siteId ? payload.siteId : null,
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
    const result = await decideApproval(deps, request, sessionOf(req).user, decision, {
      comment: body.data.comment || null,
      ip: clientIpOf(req),
    });
    if (!result.ok) {
      res.status(result.error === "forbidden" ? 403 : 409).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  }

  router.post("/:id/approve", (req, res) => decide(req, res, "APPROVED"));
  router.post("/:id/reject", (req, res) => decide(req, res, "REJECTED"));
  return router;
}

export type DecideError = "forbidden" | "own_request" | "already_decided" | "out_of_date";

/**
 * Approve or reject one request: the checks, the change itself, the audit row and the
 * follow-up (deploy kick, bulk run). Used by the Approvals page and by Super Admin
 * self-approval (A134), which is audited as approval.self_approve and alerts every other Admin.
 */
export async function decideApproval(
  deps: ApprovalsDeps,
  request: ApprovalRequest,
  user: { id: string; role: RoleName },
  decision: "APPROVED" | "REJECTED",
  opts: { comment: string | null; ip: string | null },
): Promise<{ ok: true } | { ok: false; error: DecideError }> {
  const { db, now } = deps;
  const check = canDecideApproval(request, user);
  if (!check.ok)
    return { ok: false, error: check.reason === "not_admin" ? "forbidden" : check.reason };
  const self = request.requestedById === user.id;
  const decided = {
    status: decision,
    decidedById: user.id,
    decidedAt: now(),
    comment: opts.comment ?? (self ? "Self-approved (Super Admin)" : null),
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
    if (error.message === "already decided") return { ok: false, error: "already_decided" };
    // The site changed since the request: it can't be applied as asked, so it's closed.
    await db.approvalRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        ...decided,
        status: "REJECTED",
        comment: "Out of date: the site changed after this was requested",
      },
    });
    await deps.notifier?.observe?.({
      kind: "approval.requested",
      scope: request.id,
      ok: true,
      byUserId: user.id,
      note: "Closed as out of date: the site changed after it was requested",
    });
    return { ok: false, error: "out_of_date" };
  }
  const payload = request.payload as {
    siteId?: string;
    siteIds?: string[];
    deploymentId?: string;
    restoreId?: string;
    rollbackId?: string;
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
      action: self
        ? "approval.self_approve"
        : decision === "APPROVED"
          ? "approval.approve"
          : "approval.reject",
      result: "success",
      ip: opts.ip,
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
  await deps.notifier?.observe?.({
    kind: "approval.requested",
    scope: request.id,
    ok: true,
    byUserId: user.id,
    note: self ? "Self-approved (Super Admin)" : `Request ${decision.toLowerCase()}`,
  });
  if (request.action === "deploy.bulk" && typeof payload?.deploymentId === "string") {
    await deps.onDeployBulkDecided?.(decision, payload.deploymentId, user.id);
  }
  if (request.action === "site.backup.restore" && typeof payload?.restoreId === "string") {
    await deps.onRestoreDecided?.(decision, payload.restoreId, user.id);
  }
  if (decision === "APPROVED" && request.action === "site.debuglog.bulk") {
    const ids = (request.payload as { environmentIds?: unknown } | null)?.environmentIds;
    if (Array.isArray(ids))
      void Promise.resolve(
        deps.onDebugLogBulkApproved?.(
          ids.filter((v): v is string => typeof v === "string"),
          request.requestedById,
        ),
      ).catch(() => undefined);
  }
  // A DNS rollback runs in the background: several Cloudflare calls (A156).
  if (request.action === "dns.rollback" && typeof payload?.rollbackId === "string") {
    const rollbackId = payload.rollbackId;
    void Promise.resolve(deps.onDnsRollbackDecided?.(decision, rollbackId, user.id)).catch(
      (error: unknown) => {
        console.error(
          JSON.stringify({
            event: "dns_rollback_failed",
            rollbackId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
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
  if (self) {
    const site = payload?.siteId
      ? await db.site.findUnique({ where: { id: payload.siteId }, select: { name: true } })
      : null;
    const summary = isApprovalAction(request.action)
      ? (APPROVAL_ACTIONS[request.action].describe(request.payload, site?.name ?? "a site") ??
        request.action)
      : request.action;
    await emitSelfApproved(db, deps.notifier, {
      requestId: request.id,
      action: request.action,
      summary,
      siteIds,
      userId: user.id,
    });
  }
  return { ok: true };
}

/** Tells every other Admin that a Super Admin approved their own risky action (A134). */
async function emitSelfApproved(
  db: Db,
  notifier: SecurityNotifier | undefined,
  input: { requestId: string; action: string; summary: string; siteIds: string[]; userId: string },
): Promise<void> {
  if (!notifier?.notify) return;
  const admins = (await adminUserIds(db)).filter((id) => id !== input.userId);
  if (admins.length === 0) return;
  const who = await db.user.findUnique({ where: { id: input.userId }, select: { email: true } });
  await notifier.notify({
    kind: "approval.self_approved",
    title: "Super Admin self-approved a risky action",
    body: `${who?.email ?? "A Super Admin"} approved their own request: ${input.summary}`,
    severity: "warning",
    siteIds: input.siteIds,
    recipientUserIds: admins,
    meta: { requestId: input.requestId, action: input.action },
  });
}

/**
 * When the requester is a Super Admin, approve their just-created request at once (A134).
 * Returns true if it was self-approved.
 */
export async function selfApproveIfAllowed(
  deps: ApprovalsDeps,
  requestId: string,
  user: { id: string; role: RoleName },
  ip: string | null,
): Promise<boolean> {
  if (!can(user.role, "approvals.self")) return false;
  const request = await deps.db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!request || request.requestedById !== user.id) return false;
  const result = await decideApproval(deps, request, user, "APPROVED", { comment: null, ip });
  return result.ok;
}
