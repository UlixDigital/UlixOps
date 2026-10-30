// In-app alert centre + notification channel prefs (spec screen 19).
import {
  NotificationPrefs,
  RecordId,
  type NotificationEvent,
  type NotificationList,
  type NotificationPrefsView,
  type NotificationView,
} from "@ulixops/shared";
import { Router } from "express";
import { audit } from "../audit";
import type { Db } from "../db";
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
    });
    const unreadCount = await db.notification.count({
      where: { userId: user.id, readAt: null },
    });
    const notifications: NotificationView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationEvent,
      title: r.title,
      body: r.body,
      severity: r.severity as NotificationView["severity"],
      siteIds: r.siteIds,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    const body: NotificationList = { notifications, unreadCount };
    res.json(body);
  });

  router.post("/read-all", authorize("notifications.view", deps), async (req, res) => {
    const { user } = sessionOf(req);
    await db.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: now() },
    });
    res.json({ ok: true });
  });

  router.post("/:id/read", authorize("notifications.view", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { user } = sessionOf(req);
    const updated = await db.notification.updateMany({
      where: { id: id.data, userId: user.id, readAt: null },
      data: { readAt: now() },
    });
    if (updated.count === 0) {
      const exists = await db.notification.findFirst({
        where: { id: id.data, userId: user.id },
      });
      if (!exists) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    }
    res.json({ ok: true });
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
