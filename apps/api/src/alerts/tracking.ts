// Super Admin alert follow-up report and fix verification (A158).
import {
  AlertEventType,
  type AlertDetail,
  type AlertResolution,
  type AlertRow,
  type AlertStatus,
  type AlertTrackingReport,
  type FixAction,
  isAutoVerifiedKind,
  type NotificationEvent,
  type NotificationSeverity,
  RecordId,
  TrackingDays,
  VerifyAlertRequest,
} from "@ulixops/shared";
import { Router } from "express";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Alert } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { verifyAlert } from "./followup";
import { accuracyOf, claimsFrom, dailySeries, funnel, median, memberStats } from "./metrics";

const DAY = 86_400_000;
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export interface TrackingDeps {
  db: Db;
  now: () => Date;
}

async function nameMap(db: Db, ids: Iterable<string>) {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { id: { in: list } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}

async function rowsFor(db: Db, alerts: Alert[]): Promise<AlertRow[]> {
  if (alerts.length === 0) return [];
  const ids = alerts.map((a) => a.id);
  const [sites, recipients, seen, names] = await Promise.all([
    db.site.findMany({
      where: { id: { in: [...new Set(alerts.flatMap((a) => a.siteIds))] } },
      select: { id: true, name: true },
    }),
    db.notification.groupBy({ by: ["alertId"], where: { alertId: { in: ids } }, _count: true }),
    db.notification.groupBy({
      by: ["alertId"],
      where: { alertId: { in: ids }, seenAt: { not: null } },
      _count: true,
    }),
    nameMap(
      db,
      alerts.flatMap((a) => [a.ownerId, a.resolvedById].filter((v): v is string => !!v)),
    ),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const count = (rows: { alertId: string | null; _count: number }[]) =>
    new Map(rows.map((r) => [r.alertId ?? "", r._count]));
  const recipientCount = count(recipients);
  const seenCount = count(seen);
  return alerts.map((a) => ({
    id: a.id,
    kind: a.kind as NotificationEvent,
    title: a.title,
    severity: a.severity as NotificationSeverity,
    status: a.status as AlertStatus,
    siteNames: a.siteIds.map((id) => siteName.get(id) ?? "Removed site"),
    firstRaisedAt: a.firstRaisedAt.toISOString(),
    lastRaisedAt: a.lastRaisedAt.toISOString(),
    occurrences: a.occurrences,
    recipients: recipientCount.get(a.id) ?? 0,
    seenBy: seenCount.get(a.id) ?? 0,
    ownerName: a.ownerId ? (names.get(a.ownerId) ?? null) : null,
    resolvedByName: a.resolvedById ? (names.get(a.resolvedById) ?? null) : null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    closedAt: a.closedAt?.toISOString() ?? null,
    reopenCount: a.reopenCount,
  }));
}

export async function trackingReport(
  db: Db,
  days: number,
  now: Date,
): Promise<AlertTrackingReport> {
  const from = new Date(now.getTime() - days * DAY);
  const [period, openNow] = await Promise.all([
    db.alert.findMany({ where: { firstRaisedAt: { gte: from } } }),
    db.alert.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED", "RESOLVED"] } },
      orderBy: { firstRaisedAt: "asc" },
    }),
  ]);
  const periodIds = period.map((a) => a.id);
  const [notifications, events, users] = await Promise.all([
    db.notification.findMany({
      where: { alertId: { in: periodIds } },
      select: { alertId: true, userId: true, createdAt: true, seenAt: true, readAt: true },
    }),
    db.alertEvent.findMany({
      where: {
        alertId: { in: periodIds },
        type: { in: ["RESOLVED", "CONFIRMED", "REJECTED", "REOPENED", "ACKNOWLEDGED"] },
      },
      select: { alertId: true, type: true, userId: true, subjectUserId: true, createdAt: true },
    }),
    db.user.findMany({ select: { id: true, name: true, email: true, role: true } }),
  ]);
  const metricAlerts = period.map((a) => ({ ...a, status: a.status as AlertStatus }));
  const claims = claimsFrom(metricAlerts, events);
  const actionable = metricAlerts.filter((a) => a.actionable);
  const since = (a: Date | null, b: Date) => (a ? Math.max(0, a.getTime() - b.getTime()) : null);
  const firstClaim = new Map<string, number>();
  for (const c of claims) {
    const raised = period.find((a) => a.id === c.alertId)?.firstRaisedAt;
    if (!raised) continue;
    const ms = c.at.getTime() - raised.getTime();
    if (!firstClaim.has(c.alertId) || ms < (firstClaim.get(c.alertId) ?? Infinity))
      firstClaim.set(c.alertId, ms);
  }
  const values = (list: (number | null)[]) => list.filter((v): v is number => v !== null);
  const open = openNow
    .filter((a) => a.status !== "RESOLVED")
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
        a.firstRaisedAt.getTime() - b.firstRaisedAt.getTime(),
    );
  const awaiting = openNow.filter((a) => a.status === "RESOLVED");
  const recent = await db.alert.findMany({
    where: { actionable: true, closedAt: { gte: from } },
    orderBy: { closedAt: "desc" },
    take: 50,
  });

  return {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    totals: {
      raised: period.length,
      actionable: actionable.length,
      openNow: open.length,
      criticalOpenNow: open.filter((a) => a.severity === "critical").length,
      unseenOpenNow: open.filter((a) => !a.firstSeenAt).length,
      awaitingCheck: awaiting.length,
      confirmed: claims.filter((c) => c.verdict === "CONFIRMED").length,
      rejected: claims.filter((c) => c.verdict === "REJECTED").length,
      autoCleared: actionable.filter((a) => a.status === "AUTO_CLEARED").length,
      accuracy: accuracyOf(claims),
      medianSeenMs: median(values(actionable.map((a) => since(a.firstSeenAt, a.firstRaisedAt)))),
      medianAckMs: median(values(actionable.map((a) => since(a.acknowledgedAt, a.firstRaisedAt)))),
      medianResolveMs: median([...firstClaim.values()]),
    },
    funnel: funnel(metricAlerts, claims),
    daily: dailySeries(metricAlerts, from, days),
    members: memberStats({
      users: users.map((u) => ({
        id: u.id,
        name: u.name || u.email,
        email: u.email,
        role: u.role,
      })),
      alerts: metricAlerts,
      notifications: notifications.flatMap((n) =>
        n.alertId ? [{ ...n, alertId: n.alertId }] : [],
      ),
      events,
      claims,
    }),
    // Fixes waiting for a check come first: they need a Super Admin's eye.
    open: await rowsFor(db, [...awaiting, ...open].slice(0, 100)),
    recent: await rowsFor(db, recent),
  };
}

export async function alertDetail(db: Db, id: string, now: Date): Promise<AlertDetail | null> {
  const alert = await db.alert.findUnique({ where: { id } });
  if (!alert) return null;
  const [row] = await rowsFor(db, [alert]);
  if (!row) return null;
  const [notifications, events] = await Promise.all([
    db.notification.findMany({ where: { alertId: id }, orderBy: { createdAt: "asc" } }),
    db.alertEvent.findMany({ where: { alertId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  // What actually happened on the alert's sites (or by the people handling it) meanwhile.
  const until = new Date((alert.closedAt ?? now).getTime() + 60 * 60_000);
  const people = [alert.ownerId, alert.resolvedById].filter((v): v is string => !!v);
  const evidence = await db.auditLog.findMany({
    where: {
      createdAt: { gte: alert.firstRaisedAt, lte: until },
      NOT: [{ action: { startsWith: "alert." } }, { action: "rbac.denied" }],
      OR: [
        ...(alert.siteIds.length ? [{ siteIds: { hasSome: alert.siteIds } }] : []),
        ...(people.length ? [{ userId: { in: people } }] : []),
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const recipientIds = notifications.map((n) => n.userId);
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(recipientIds)] } },
    select: { id: true, name: true, email: true, role: true },
  });
  const names = await nameMap(db, [
    ...events.flatMap((e) => [e.userId, e.subjectUserId].filter((v): v is string => !!v)),
    ...evidence.flatMap((e) => (e.userId ? [e.userId] : [])),
    ...(alert.verifiedById ? [alert.verifiedById] : []),
  ]);
  const userRow = new Map(users.map((u) => [u.id, u]));
  // Repeats give a user several rows: one recipient line with their earliest times.
  const perUser = new Map<string, (typeof notifications)[number][]>();
  for (const n of notifications) perUser.set(n.userId, [...(perUser.get(n.userId) ?? []), n]);
  const earliest = (dates: (Date | null)[]) => {
    const list = dates.filter((d): d is Date => d !== null).map((d) => d.getTime());
    return list.length ? new Date(Math.min(...list)).toISOString() : null;
  };

  return {
    alert: {
      ...row,
      body: alert.body,
      actionable: alert.actionable,
      autoVerify: isAutoVerifiedKind(alert.kind),
      firstSeenAt: alert.firstSeenAt?.toISOString() ?? null,
      acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
      resolution: (alert.resolution as AlertResolution | null) ?? null,
      fixAction: (alert.fixAction as FixAction | null) ?? null,
      resolutionNote: alert.resolutionNote,
      verifiedAt: alert.verifiedAt?.toISOString() ?? null,
      verifiedByName: alert.verifiedById ? (names.get(alert.verifiedById) ?? null) : null,
      siteIds: alert.siteIds,
    },
    recipients: [...perUser.entries()].map(([userId, rows]) => {
      const u = userRow.get(userId);
      return {
        userId,
        name: u ? u.name || u.email : "Removed user",
        email: u?.email ?? "",
        role: u?.role ?? "",
        deliveredAt: earliest(rows.map((r) => r.createdAt)) ?? alert.firstRaisedAt.toISOString(),
        seenAt: earliest(rows.map((r) => r.seenAt)),
        readAt: earliest(rows.map((r) => r.readAt)),
      };
    }),
    events: events.flatMap((e) => {
      const type = AlertEventType.safeParse(e.type);
      if (!type.success) return [];
      return [
        {
          id: e.id,
          type: type.data,
          actorName: e.userId ? (names.get(e.userId) ?? "Removed user") : null,
          subjectName: e.subjectUserId ? (names.get(e.subjectUserId) ?? null) : null,
          note: e.note,
          createdAt: e.createdAt.toISOString(),
        },
      ];
    }),
    evidence: evidence.map((e) => ({
      id: e.id,
      action: e.action,
      result: e.result,
      userName: e.userId ? (names.get(e.userId) ?? "Removed user") : null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export function trackingRouter(deps: TrackingDeps): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("alerts.track", deps));

  router.get("/", async (req, res) => {
    const days = TrackingDays.safeParse(req.query.days ?? 30);
    if (!days.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    res.json(await trackingReport(db, days.data, now()));
  });

  router.get("/:id", async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const detail = id.success ? await alertDetail(db, id.data, now()) : null;
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(detail);
  });

  router.post("/:id/verify", async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const body = VerifyAlertRequest.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const result = await verifyAlert(db, id.data, user, body.data, now());
    await audit(
      db,
      {
        userId: user.id,
        action: "alert.verify",
        result: result.ok ? "success" : result.error,
        ip: clientIpOf(req),
        siteIds: result.ok ? result.siteIds : [],
        meta: { alertId: id.data, outcome: body.data.outcome, note: body.data.note },
      },
      now(),
    );
    if (!result.ok) {
      res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
