// Alert follow-up (agent decision A158): groups notifications into Alerts, records who saw,
// took and fixed each one, and lets later checks confirm or reject a claimed fix.
import {
  alertTransition,
  type AlertAction,
  type AlertEventType,
  type AlertStatus,
  type FixAction,
  type NotificationSeverity,
  RECOVERY_ALERT_KINDS,
  type ResolveAlertRequest,
  type VerifyAlertRequest,
  isActionableKind,
  type NotificationEvent,
} from "@ulixops/shared";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

const UNCLOSED: AlertStatus[] = ["OPEN", "ACKNOWLEDGED", "RESOLVED"];

export interface RaiseInput {
  kind: NotificationEvent;
  title: string;
  body: string;
  severity: NotificationSeverity;
  siteIds: string[];
  scope?: string | null;
}

export interface ObserveInput {
  /** The problem kind being re-checked, e.g. "malware.found". */
  kind: NotificationEvent;
  siteIds?: string[];
  scope?: string | null;
  /** true: the check came back clean; false: still failing. */
  ok: boolean;
  /**
   * Person the hub saw fix it (mark-safe, ran a clean scan, decided an approval). When set,
   * or when someone already took the alert ("I'm on it"), we credit them as the solver (A176).
   */
  byUserId?: string;
  /** What they did, when byUserId (or the owner) is credited. */
  fixAction?: FixAction;
  note: string;
}

function event(
  tx: Tx | Db,
  alertId: string,
  type: AlertEventType,
  at: Date,
  extra: { userId?: string | null; subjectUserId?: string | null; note?: string | null } = {},
) {
  return tx.alertEvent.create({
    data: {
      alertId,
      type,
      userId: extra.userId ?? null,
      subjectUserId: extra.subjectUserId ?? null,
      note: extra.note?.slice(0, 2000) ?? null,
      createdAt: at,
    },
  });
}

/**
 * Unclosed alerts of `kind` on exactly these sites; there, alerts without a scope (raised
 * before scopes existed) match any scope. Without sites, the scope must match exactly.
 */
function findUnclosed(
  tx: Tx | Db,
  input: { kind: string; siteIds?: string[]; scope?: string | null },
) {
  const scope = input.scope ?? null;
  return tx.alert.findMany({
    where: {
      kind: input.kind,
      status: { in: UNCLOSED },
      ...(input.siteIds
        ? {
            siteIds: { equals: [...new Set(input.siteIds)].sort() },
            ...(scope ? { OR: [{ scope }, { scope: null }] } : {}),
          }
        : { scope }),
    },
    orderBy: { lastRaisedAt: "desc" },
  });
}

/** Clears the claimed-fix fields when a fix is rejected and the alert goes back to OPEN. */
const UNRESOLVE = {
  resolvedAt: null,
  resolvedById: null,
  resolution: null,
  fixAction: null,
  resolutionNote: null,
  verifiedAt: null,
  verifiedById: null,
  closedAt: null,
} as const;

/**
 * Records a notification-worthy event as an Alert and returns its id. A repeat of an unclosed
 * problem joins that Alert; a repeat after someone reported it fixed rejects that fix.
 */
export async function raiseAlert(db: Db, input: RaiseInput, at: Date): Promise<string> {
  const siteIds = [...new Set(input.siteIds)].sort();
  const scope = input.scope ?? null;
  const base = {
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 2000),
    severity: input.severity,
  };

  if (!isActionableKind(input.kind)) {
    const created = await db.$transaction(async (tx) => {
      const alert = await tx.alert.create({
        data: {
          ...base,
          siteIds,
          scope,
          actionable: false,
          status: "INFO",
          firstRaisedAt: at,
          lastRaisedAt: at,
          closedAt: at,
        },
      });
      await event(tx, alert.id, "RAISED", at);
      return alert.id;
    });
    for (const problem of RECOVERY_ALERT_KINDS[input.kind] ?? []) {
      await observeAlerts(
        db,
        { kind: problem, siteIds, scope, ok: true, note: input.title.slice(0, 200) },
        at,
      );
    }
    return created;
  }

  return db.$transaction(async (tx) => {
    const [existing] = await findUnclosed(tx, { kind: input.kind, siteIds, scope });
    if (!existing) {
      const alert = await tx.alert.create({
        data: {
          ...base,
          siteIds,
          scope,
          actionable: true,
          status: "OPEN",
          firstRaisedAt: at,
          lastRaisedAt: at,
        },
      });
      await event(tx, alert.id, "RAISED", at);
      return alert.id;
    }
    const wasResolved = existing.status === "RESOLVED";
    await tx.alert.update({
      where: { id: existing.id },
      data: {
        ...base,
        scope: existing.scope ?? scope,
        occurrences: { increment: 1 },
        lastRaisedAt: at,
        ...(wasResolved ? { ...UNRESOLVE, status: "OPEN", reopenCount: { increment: 1 } } : {}),
      },
    });
    if (wasResolved)
      await event(tx, existing.id, "REJECTED", at, {
        subjectUserId: existing.resolvedById,
        note: `The problem was reported again after the fix: ${base.title}`,
      });
    await event(tx, existing.id, "REPEATED", at, { note: base.title });
    return existing.id;
  });
}

/**
 * A later check on the same problem: clean closes it (confirming a claimed fix), still failing
 * rejects a claimed fix. Never throws to the caller.
 */
export async function observeAlerts(db: Db, input: ObserveInput, at: Date): Promise<void> {
  try {
    const alerts = await findUnclosed(db, input);
    for (const alert of alerts) {
      await db.$transaction(async (tx) => {
        // Re-read inside the transaction: a person may have acted in between.
        const current = await tx.alert.findUnique({ where: { id: alert.id } });
        if (!current) return;
        if (!input.ok) {
          if (current.status !== "RESOLVED") return;
          await tx.alert.update({
            where: { id: current.id },
            data: { ...UNRESOLVE, status: "OPEN", reopenCount: { increment: 1 } },
          });
          await event(tx, current.id, "REJECTED", at, {
            subjectUserId: current.resolvedById,
            note: input.note,
          });
          return;
        }
        // Credit a known solver without requiring "I'm on it" / Report fix (A176):
        // - byUserId from a hub action (mark-safe, clean scan, approval), or
        // - ownerId if someone already took the alert and a later check came back clean.
        const solverId =
          current.status === "RESOLVED"
            ? null
            : (input.byUserId ?? current.ownerId ?? null);
        if (solverId) {
          const fixAction =
            input.fixAction ??
            (input.byUserId && current.kind === "approval.requested"
              ? "approval_decided"
              : "other");
          await tx.alert.update({
            where: { id: current.id },
            data: {
              status: "VERIFIED",
              ownerId: current.ownerId ?? solverId,
              acknowledgedAt: current.acknowledgedAt ?? at,
              resolvedAt: at,
              resolvedById: solverId,
              resolution: "FIXED",
              fixAction,
              resolutionNote: input.note,
              verifiedAt: at,
              verifiedById: null,
              closedAt: at,
            },
          });
          await event(tx, current.id, "RESOLVED", at, {
            userId: solverId,
            note: input.note,
          });
          await event(tx, current.id, "CONFIRMED", at, {
            subjectUserId: solverId,
            note: "Seen by UlixOps",
          });
          return;
        }
        const next = alertTransition(current.status, "clear");
        if (!next) return;
        if (next === "VERIFIED") {
          await tx.alert.update({
            where: { id: current.id },
            data: { status: next, verifiedAt: at, verifiedById: null, closedAt: at },
          });
          await event(tx, current.id, "CONFIRMED", at, {
            subjectUserId: current.resolvedById,
            note: input.note,
          });
        } else {
          await tx.alert.update({
            where: { id: current.id },
            data: { status: next, closedAt: at },
          });
          await event(tx, current.id, "AUTO_CLEARED", at, { note: input.note });
        }
      });
    }
  } catch (error) {
    console.error(`alerts: observe failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

// ---- Seen / read ----------------------------------------------------------------------------

/** Stamps seenAt on the user's own notifications that were not seen yet; returns how many. */
export async function markSeen(
  db: Db,
  userId: string,
  where: Prisma.NotificationWhereInput,
  at: Date,
  opts: { read?: boolean } = {},
): Promise<number> {
  const rows = await db.notification.findMany({
    where: {
      ...where,
      userId,
      ...(opts.read ? { readAt: null } : { seenAt: null }),
    },
    select: { id: true, alertId: true, seenAt: true },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await db.$transaction(async (tx) => {
    const unseen = rows.filter((r) => !r.seenAt).map((r) => r.id);
    if (unseen.length)
      await tx.notification.updateMany({
        where: { id: { in: unseen }, seenAt: null },
        data: { seenAt: at },
      });
    if (opts.read)
      await tx.notification.updateMany({
        where: { id: { in: ids }, readAt: null },
        data: { readAt: at },
      });
    const alertIds = [...new Set(rows.flatMap((r) => (r.alertId ? [r.alertId] : [])))];
    const newlySeen = [
      ...new Set(rows.flatMap((r) => (!r.seenAt && r.alertId ? [r.alertId] : []))),
    ];
    const data: Prisma.AlertEventCreateManyInput[] = [
      ...newlySeen.map((alertId) => ({ alertId, type: "SEEN", userId, createdAt: at })),
      ...(opts.read
        ? alertIds.map((alertId) => ({ alertId, type: "READ", userId, createdAt: at }))
        : []),
    ];
    if (data.length) await tx.alertEvent.createMany({ data });
    if (newlySeen.length)
      await tx.alert.updateMany({
        where: { id: { in: newlySeen }, firstSeenAt: null },
        data: { firstSeenAt: at },
      });
  });
  return rows.length;
}

// ---- People acting on an alert ----------------------------------------------------------------

export type FollowupError = "not_found" | "forbidden" | "alert_state";
export type FollowupResult =
  | { ok: true; siteIds: string[]; kind: string; status: AlertStatus }
  | { ok: false; error: FollowupError };

async function loadForActor(db: Db, alertId: string, user: { id: string }, anyAlert: boolean) {
  const alert = await db.alert.findUnique({ where: { id: alertId } });
  if (!alert) return null;
  if (anyAlert) return alert;
  const mine = await db.notification.count({ where: { alertId, userId: user.id } });
  return mine > 0 ? alert : null;
}

/**
 * Moves the alert with optimistic locking on its status: a concurrent change makes it fail
 * with alert_state instead of overwriting someone else's step.
 */
async function move(
  tx: Tx,
  alert: { id: string; status: AlertStatus },
  action: AlertAction,
  data: Prisma.AlertUpdateManyMutationInput,
): Promise<AlertStatus | null> {
  const next = alertTransition(alert.status, action);
  if (!next) return null;
  const { count } = await tx.alert.updateMany({
    where: { id: alert.id, status: alert.status },
    data: { ...data, status: next },
  });
  return count === 1 ? next : null;
}

class Conflict extends Error {}

async function guarded(run: () => Promise<FollowupResult>): Promise<FollowupResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Conflict) return { ok: false, error: "alert_state" };
    throw error;
  }
}

/** "I'm on it": the user becomes the owner (taking over from another owner is recorded). */
export function acknowledgeAlert(
  db: Db,
  alertId: string,
  user: { id: string; canTrack: boolean },
  at: Date,
): Promise<FollowupResult> {
  return guarded(async () => {
    const alert = await loadForActor(db, alertId, user, user.canTrack);
    if (!alert) return { ok: false, error: "not_found" };
    if (alert.status === "ACKNOWLEDGED" && alert.ownerId === user.id)
      return { ok: true, siteIds: alert.siteIds, kind: alert.kind, status: alert.status };
    const status = await db.$transaction(async (tx) => {
      const next = await move(tx, alert, "acknowledge", {
        ownerId: user.id,
        acknowledgedAt: alert.acknowledgedAt ?? at,
      });
      if (!next) throw new Conflict();
      const previous = alert.ownerId && alert.ownerId !== user.id ? alert.ownerId : null;
      await event(tx, alert.id, "ACKNOWLEDGED", at, {
        userId: user.id,
        subjectUserId: previous,
        note: previous ? "Took over from the previous owner" : null,
      });
      return next;
    });
    await markSeen(db, user.id, { alertId }, at);
    return { ok: true, siteIds: alert.siteIds, kind: alert.kind, status };
  });
}

/** The user reports the fix (or a false alarm) and what they did. */
export function resolveAlert(
  db: Db,
  alertId: string,
  user: { id: string; canTrack: boolean },
  body: ResolveAlertRequest,
  at: Date,
): Promise<FollowupResult> {
  return guarded(async () => {
    const alert = await loadForActor(db, alertId, user, user.canTrack);
    if (!alert) return { ok: false, error: "not_found" };
    // Approval alerts close when someone decides the request on the Approvals page.
    if (alert.kind === "approval.requested") return { ok: false, error: "alert_state" };
    const status = await db.$transaction(async (tx) => {
      const next = await move(tx, alert, "resolve", {
        ownerId: alert.ownerId ?? user.id,
        acknowledgedAt: alert.acknowledgedAt ?? at,
        resolvedAt: at,
        resolvedById: user.id,
        resolution: body.resolution,
        fixAction: body.fixAction,
        resolutionNote: body.note,
      });
      if (!next) throw new Conflict();
      await event(tx, alert.id, "RESOLVED", at, { userId: user.id, note: body.note });
      return next;
    });
    await markSeen(db, user.id, { alertId }, at, { read: true });
    return { ok: true, siteIds: alert.siteIds, kind: alert.kind, status };
  });
}

/** Super Admin: confirm or reject a reported fix, or reopen a closed alert. */
export function verifyAlert(
  db: Db,
  alertId: string,
  user: { id: string },
  body: VerifyAlertRequest,
  at: Date,
): Promise<FollowupResult> {
  return guarded(async () => {
    const alert = await db.alert.findUnique({ where: { id: alertId } });
    if (!alert) return { ok: false, error: "not_found" };
    const status = await db.$transaction(async (tx) => {
      if (body.outcome === "CONFIRMED") {
        const next = await move(tx, alert, "confirm", {
          verifiedAt: at,
          verifiedById: user.id,
          closedAt: at,
        });
        if (!next) throw new Conflict();
        await event(tx, alert.id, "CONFIRMED", at, {
          userId: user.id,
          subjectUserId: alert.resolvedById,
          note: body.note,
        });
        return next;
      }
      const action: AlertAction = body.outcome === "REJECTED" ? "reject" : "reopen";
      const next = await move(tx, alert, action, {
        ...UNRESOLVE,
        reopenCount: { increment: 1 },
      });
      if (!next) throw new Conflict();
      // Reopening a confirmed fix means it did not hold: that fix is judged as rejected too.
      if (action === "reject" || alert.resolvedById)
        await event(tx, alert.id, "REJECTED", at, {
          userId: user.id,
          subjectUserId: alert.resolvedById,
          note: body.note,
        });
      if (action === "reopen")
        await event(tx, alert.id, "REOPENED", at, { userId: user.id, note: body.note });
      return next;
    });
    return { ok: true, siteIds: alert.siteIds, kind: alert.kind, status };
  });
}
