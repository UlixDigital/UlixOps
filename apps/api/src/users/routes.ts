// Users & roles (spec screen 21): invite, change role, deactivate, reset 2FA, sessions.
import { InviteUserRequest, RecordId, UpdateUserRequest } from "@ulixops/shared";
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
      data: { email: body.data.email, name: body.data.name || null, role: body.data.role },
    });
    const link = await setupLink(user.id);
    await record(req, "user.invite", user.id, { email: user.email, role: user.role });
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
    const user = await target(req, res);
    if (!user) return;
    const { role, active, name } = body.data;
    const roleChanges = role !== undefined && role !== user.role;
    const activeChanges = active !== undefined && active !== user.active;

    // Admins cannot lock themselves out; another Admin has to do it.
    if (user.id === sessionOf(req).user.id && (roleChanges || activeChanges)) {
      {
        fail(res, 409, "cannot_change_self");
        return;
      }
    }
    const losesAdmin =
      user.role === "ADMIN" &&
      user.active &&
      ((roleChanges && role !== "ADMIN") || active === false);
    if (losesAdmin) {
      const otherAdmins = await db.user.count({
        where: { role: "ADMIN", active: true, id: { not: user.id } },
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
      },
    });
    if (active === false) await revokeSessions(db, { userId: user.id }, now());

    const changes: Record<string, (string | boolean | null)[]> = {};
    if (roleChanges) changes.role = [user.role, updated.role];
    if (activeChanges) changes.active = [user.active, updated.active];
    if (name !== undefined && name !== user.name) changes.name = [user.name, updated.name];
    await record(req, "user.update", user.id, { changes });
    if (roleChanges && updated.role === "ADMIN") await alert(req, "ADMIN_ROLE_GRANTED", user.id);
    res.json({ user: toUserSummary(updated, await sessionCount(user.id)) });
  });

  router.post("/:id/reset-2fa", async (req, res) => {
    const user = await target(req, res);
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
    const user = await target(req, res);
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
    const user = await target(req, res);
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
