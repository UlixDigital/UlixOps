// Users & roles (spec screen 21): invite, change role, deactivate, reset 2FA, sessions.
import {
  AssignableRole,
  InviteUserRequest,
  RecordId,
  UpdateUserRequest,
  ADMIN_ROLES,
  isAdminRole,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { raiseAlert } from "../alerts";
import { audit } from "../audit";
import { issueSetupToken } from "../auth/service";
import type { Db } from "../db";
import type { Prisma, User } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import { liveSessions, revokeSessions, toSessionSummary, toUserSummary } from "./sessions";

export interface UsersDeps {
  db: Db;
  now: () => Date;
  notifier: SecurityNotifier;
  sessionSecret: string;
  publicUrl: string;
}

export function usersRouter(deps: UsersDeps): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("users.manage", deps));

  const fail = (res: Response, status: number, error: string) => {
    res.status(status).json({ error });
  };
  const record = (
    req: Request,
    action: string,
    subjectId: string,
    meta: Prisma.InputJsonObject = {},
  ) =>
    audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action,
        result: "success",
        ip: clientIpOf(req),
        meta: { subjectId, ...meta },
      },
      now(),
    );
  const alert = (req: Request, kind: "ADMIN_ROLE_GRANTED" | "TWO_FACTOR_RESET", userId: string) =>
    raiseAlert(
      db,
      deps.notifier,
      {
        kind,
        userId,
        ip: clientIpOf(req) ?? "unknown",
        userAgent: "",
        actorId: sessionOf(req).user.id,
      },
      now(),
    );
  const setupLink = async (userId: string) => {
    const { token, expiresAt } = await issueSetupToken(db, userId, deps.sessionSecret, now());
    const link = new URL("/setup", deps.publicUrl);
    link.searchParams.set("token", token);
    return { setupLink: link.toString(), expiresAt: expiresAt.toISOString() };
  };
  async function target(req: Request, res: Response): Promise<User | null> {
    const id = RecordId.safeParse(req.params.id);
    const user = id.success ? await db.user.findUnique({ where: { id: id.data } }) : null;
    if (!user) fail(res, 404, "not_found");
    return user;
  }
  /** A user to change. Only a Super Admin may change a Super Admin (A134). */
  async function targetToChange(req: Request, res: Response): Promise<User | null> {
    const user = await target(req, res);
    if (user?.role === "SUPER_ADMIN" && sessionOf(req).user.role !== "SUPER_ADMIN") {
      fail(res, 403, "forbidden");
      return null;
    }
    return user;
  }
  async function sessionCount(userId: string) {
    return db.session.count({ where: { userId, ...liveSessions(now()) } });
  }

  router.get("/", async (_req, res) => {
    const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
    const counts = await db.session.groupBy({
      by: ["userId"],
      where: liveSessions(now()),
      _count: { _all: true },
    });
    const byUser = new Map(counts.map((c) => [c.userId, c._count._all]));
    res.json({ users: users.map((u) => toUserSummary(u, byUser.get(u.id) ?? 0)) });
  });

  router.post("/", async (req, res) => {
    const body = InviteUserRequest.safeParse(req.body);
    if (!body.success) {
      fail(res, 400, "bad_request");
      return;
    }
    if (await db.user.findUnique({ where: { email: body.data.email } })) {
      {
        fail(res, 409, "email_taken");
        return;
      }
    }
    const user = await db.user.create({
      data: {
        email: body.data.email,
        name: body.data.name || null,
        role: body.data.role,
        viewTag: body.data.role === "CLIENT_VIEWER" ? (body.data.viewTag ?? null) : null,
      },
    });
    const link = await setupLink(user.id);
    await record(req, "user.invite", user.id, {
      email: user.email,
      role: user.role,
      ...(user.viewTag ? { viewTag: user.viewTag } : {}),
    });
    if (user.role === "ADMIN") await alert(req, "ADMIN_ROLE_GRANTED", user.id);
    res.status(201).json({ user: toUserSummary(user, 0), ...link });
  });

  router.get("/:id", async (req, res) => {
    const user = await target(req, res);
    if (!user) return;
    const sessions = await db.session.findMany({
      where: { userId: user.id, ...liveSessions(now()) },
      orderBy: { lastSeenAt: "desc" },
    });
    res.json({
      user: toUserSummary(user, sessions.length),
      sessions: sessions.map((s) => toSessionSummary(s, sessionOf(req).sessionId)),
    });
  });

  router.patch("/:id", async (req, res) => {
    const body = UpdateUserRequest.safeParse(req.body);
    if (!body.success) {
      fail(res, 400, "bad_request");
      return;
    }
    const user = await targetToChange(req, res);
    if (!user) return;
    const actor = sessionOf(req).user;
    const { role, active, name, viewTag } = body.data;
    const roleChanges = role !== undefined && role !== user.role;
    const activeChanges = active !== undefined && active !== user.active;
    const nextRole = role ?? user.role;
    // Client Viewer always stores exactly one tag; every other role clears it (A178).
    const nextViewTag =
      nextRole === "CLIENT_VIEWER"
        ? (viewTag !== undefined ? viewTag : user.viewTag)
        : null;
    if (nextRole === "CLIENT_VIEWER" && !nextViewTag) {
      fail(res, 400, "bad_request");
      return;
    }
    const viewTagChanges = nextViewTag !== user.viewTag;

    // Admins cannot lock themselves out; another Admin has to do it.
    if (user.id === actor.id && (roleChanges || activeChanges)) {
      fail(res, 409, "cannot_change_self");
      return;
    }

    // Super Admin assign/remove: only a Super Admin; promote only from Admin with 2FA (A172).
    if (roleChanges && role === "SUPER_ADMIN") {
      if (actor.role !== "SUPER_ADMIN") {
        fail(res, 403, "forbidden");
        return;
      }
      if (user.role !== "ADMIN" || !user.twoFactorEnabled) {
        fail(res, 409, "needs_admin_2fa");
        return;
      }
    }
    if (roleChanges && role !== undefined && role !== "SUPER_ADMIN") {
      // Regular Admins may only assign inviteable roles; demoting a Super Admin is Super-only
      // (already enforced by targetToChange when the target is SUPER_ADMIN).
      if (actor.role !== "SUPER_ADMIN" && !AssignableRole.safeParse(role).success) {
        fail(res, 403, "forbidden");
        return;
      }
    }

    const losesAdmin =
      isAdminRole(user.role) &&
      user.active &&
      ((roleChanges && !isAdminRole(role)) || active === false);
    if (losesAdmin) {
      const otherAdmins = await db.user.count({
        where: { role: { in: [...ADMIN_ROLES] }, active: true, id: { not: user.id } },
      });
      if (otherAdmins === 0) {
        fail(res, 409, "last_admin");
        return;
      }
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        ...(roleChanges ? { role } : {}),
        ...(activeChanges ? { active } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(viewTagChanges ? { viewTag: nextViewTag } : {}),
      },
    });
    if (active === false) await revokeSessions(db, { userId: user.id }, now());

    const changes: Record<string, (string | boolean | null)[]> = {};
    if (roleChanges) changes.role = [user.role, updated.role];
    if (activeChanges) changes.active = [user.active, updated.active];
    if (name !== undefined && name !== user.name) changes.name = [user.name, updated.name];
    if (viewTagChanges) changes.viewTag = [user.viewTag, updated.viewTag];
    await record(req, "user.update", user.id, { changes });
    if (roleChanges && updated.role === "ADMIN" && user.role !== "SUPER_ADMIN")
      await alert(req, "ADMIN_ROLE_GRANTED", user.id);
    if (roleChanges && (updated.role === "SUPER_ADMIN" || user.role === "SUPER_ADMIN")) {
      const grant = updated.role === "SUPER_ADMIN";
      await record(req, grant ? "user.super_admin.grant" : "user.super_admin.revoke", user.id, {
        via: "ui",
        from: user.role,
        to: updated.role,
      });
      await deps.notifier.notify?.({
        kind: "security.ADMIN_ROLE_GRANTED",
        title: grant ? "Super Admin granted" : "Super Admin removed",
        body: grant
          ? `${updated.email} is now a Super Admin (set by ${actor.email}): their risky actions are approved without a second Admin.`
          : `${updated.email} is an Admin again (set by ${actor.email}).`,
        severity: grant ? "critical" : "info",
        meta: { subjectUserId: user.id, via: "ui" },
        scope: user.id,
      });
    }
    res.json({ user: toUserSummary(updated, await sessionCount(user.id)) });
  });

  router.post("/:id/reset-2fa", async (req, res) => {
    const user = await targetToChange(req, res);
    if (!user) return;
    if (user.id === sessionOf(req).user.id) {
      fail(res, 409, "cannot_change_self");
      return;
    }
    // Their next sign-in (password) leads straight into setting up 2FA again.
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, totpSecretEnc: null, totpLastStep: null },
    });
    await db.authChallenge.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now() },
    });
    await db.passkey.deleteMany({ where: { userId: user.id } });
    const ended = await revokeSessions(db, { userId: user.id }, now());
    await record(req, "user.reset_2fa", user.id, { sessionsEnded: ended });
    await alert(req, "TWO_FACTOR_RESET", user.id);
    res.json({ ok: true });
  });

  // Before first setup: a new invite link. After: a password reset link. Using a reset link
  // ends every session, and the account's 2FA is still required (agent decision A39).
  router.post("/:id/setup-link", async (req, res) => {
    const user = await targetToChange(req, res);
    if (!user) return;
    if (user.id === sessionOf(req).user.id) {
      fail(res, 409, "cannot_change_self");
      return;
    }
    // Only the newest link works.
    await db.setupToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now() },
    });
    const link = await setupLink(user.id);
    await record(req, user.passwordHash ? "user.password_reset_link" : "user.setup_link", user.id);
    res.json(link);
  });

  router.post("/:id/sessions/:sessionId/revoke", async (req, res) => {
    const user = await targetToChange(req, res);
    if (!user) return;
    const sessionId = RecordId.safeParse(req.params.sessionId);
    if (!sessionId.success) {
      fail(res, 404, "not_found");
      return;
    }
    const ended = await revokeSessions(db, { id: sessionId.data, userId: user.id }, now());
    if (ended === 0) {
      fail(res, 404, "not_found");
      return;
    }
    await record(req, "session.revoke", user.id, { sessionId: sessionId.data });
    res.json({ ok: true });
  });

  return router;
}
