// In-app alert centre + notification channel prefs (spec screen 19).
import {
  type AlertBrief,
  type AlertResolution,
  type AlertStatus,
  can,
  type FixAction,
  isAutoVerifiedKind,
  MarkSeenRequest,
  NotificationPrefs,
  RecordId,
  ResolveAlertRequest,
  type NotificationEvent,
  type NotificationList,
  type NotificationPrefsView,
  type NotificationView,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { acknowledgeAlert, type FollowupResult, markSeen, resolveAlert } from "../alerts/followup";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Alert } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { readNotificationPrefs, writeNotificationPrefs } from "./prefs";

export interface NotificationRouteDeps {
  db: Db;
  now: () => Date;
  configured: { email: boolean; slack: boolean };
}

export function notificationsRouter(deps: NotificationRouteDeps): Router {
  const { db, now } = deps;
  const router = Router();

  router.get("/", authorize("notifications.view", deps), async (req, res) => {
    const { user } = sessionOf(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const unreadOnly = req.query.unread === "1";
    const rows = await db.notification.findMany({
      where: {
        userId: user.id,
        ...(unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { alert: true },
    });
    const unreadCount = await db.notification.count({
      where: { userId: user.id, readAt: null },
    });
    const briefs = await alertBriefs(
      db,
      rows.flatMap((r) => (r.alert ? [r.alert] : [])),
      user.id,
    );
    const notifications: NotificationView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationEvent,
      title: r.title,
      body: r.body,
      severity: r.severity as NotificationView["severity"],
      siteIds: r.siteIds,
      seenAt: r.seenAt?.toISOString() ?? null,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      alert: (r.alertId && briefs.get(r.alertId)) || null,
    }));
    const body: NotificationList = { notifications, unreadCount };
    res.json(body);
  });

  router.post("/read-all", authorize("notifications.view", deps), async (req, res) => {
    const { user } = sessionOf(req);
    await markSeen(db, user.id, {}, now(), { read: true });
    res.json({ ok: true });
  });

  // The user actually looked at these (opened the bell, a popup or the page): A158.
  router.post("/seen", authorize("notifications.view", deps), async (req, res) => {
    const body = MarkSeenRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    await markSeen(db, user.id, { id: { in: body.data.ids } }, now());
    res.json({ ok: true });
  });

  router.post("/:id/read", authorize("notifications.view", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { user } = sessionOf(req);
    const exists = await db.notification.findFirst({
      where: { id: id.data, userId: user.id },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await markSeen(db, user.id, { id: id.data }, now(), { read: true });
    res.json({ ok: true });
  });

  /** Answers an acknowledge / resolve and audits it (who, what, sites, IP, result). */
  async function followup(
    req: Request,
    res: Response,
    action: "alert.acknowledge" | "alert.resolve",
    run: (alertId: string, user: { id: string; canTrack: boolean }) => Promise<FollowupResult>,
    meta: Record<string, string> = {},
  ) {
    const id = RecordId.safeParse(req.params.alertId);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { user } = sessionOf(req);
    const result = await run(id.data, { id: user.id, canTrack: can(user.role, "alerts.track") });
    await audit(
      db,
      {
        userId: user.id,
        action,
        result: result.ok ? "success" : result.error,
        ip: clientIpOf(req),
        siteIds: result.ok ? result.siteIds : [],
        meta: {
          alertId: id.data,
          ...(result.ok ? { kind: result.kind, status: result.status } : {}),
          ...meta,
        },
      },
      now(),
    );
    if (!result.ok) {
      res
        .status(result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409)
        .json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  }

  router.post("/alerts/:alertId/acknowledge", authorize("notifications.view", deps), (req, res) =>
    followup(req, res, "alert.acknowledge", (alertId, user) =>
      acknowledgeAlert(db, alertId, user, now()),
    ),
  );

  router.post("/alerts/:alertId/resolve", authorize("notifications.view", deps), (req, res) => {
    const body = ResolveAlertRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    return followup(
      req,
      res,
      "alert.resolve",
      (alertId, user) => resolveAlert(db, alertId, user, body.data, now()),
      { resolution: body.data.resolution, fixAction: body.data.fixAction },
    );
  });

  router.get("/prefs", authorize("settings.manage", deps), async (_req, res) => {
    const view: NotificationPrefsView = {
      prefs: await readNotificationPrefs(db),
      configured: deps.configured,
    };
    res.json(view);
  });

  router.put("/prefs", authorize("settings.manage", deps), async (req, res) => {
    const body = NotificationPrefs.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const before = await readNotificationPrefs(db);
    const after = await writeNotificationPrefs(db, body.data, user.id);
    await audit(
      db,
      {
        userId: user.id,
        action: "settings.notifications",
        result: "success",
        ip: clientIpOf(req),
        meta: { before, after },
      },
      now(),
    );
    const view: NotificationPrefsView = {
      prefs: after,
      configured: deps.configured,
    };
    res.json(view);
  });

  return router;
}

/** Follow-up state for the alerts behind a page of notifications, with people's names. */
async function alertBriefs(db: Db, alerts: Alert[], viewerId: string) {
  const unique = [...new Map(alerts.map((a) => [a.id, a])).values()];
  const userIds = [
    ...new Set(unique.flatMap((a) => [a.ownerId, a.resolvedById].filter((v): v is string => !!v))),
  ];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name || u.email]));
  const reopened = unique.filter((a) => a.reopenCount > 0 && a.status === "OPEN").map((a) => a.id);
  const rejects = reopened.length
    ? await db.alertEvent.findMany({
        where: { alertId: { in: reopened }, type: "REJECTED" },
        orderBy: { createdAt: "desc" },
        select: { alertId: true, note: true },
      })
    : [];
  const lastReject = new Map<string, string | null>();
  for (const r of rejects) if (!lastReject.has(r.alertId)) lastReject.set(r.alertId, r.note);

  const out = new Map<string, AlertBrief>();
  for (const a of unique) {
    out.set(a.id, {
      id: a.id,
      status: a.status as AlertStatus,
      actionable: a.actionable,
      autoVerify: isAutoVerifiedKind(a.kind),
      occurrences: a.occurrences,
      ownerName: a.ownerId ? (names.get(a.ownerId) ?? null) : null,
      ownerIsMe: a.ownerId === viewerId,
      resolvedByName: a.resolvedById ? (names.get(a.resolvedById) ?? null) : null,
      resolution: (a.resolution as AlertResolution | null) ?? null,
      fixAction: (a.fixAction as FixAction | null) ?? null,
      resolutionNote: a.resolutionNote,
      lastRejectNote: lastReject.get(a.id) ?? null,
    });
  }
  return out;
}
