// My account (spec screen 23): profile and the signed-in user's own sessions.
import {
  AddPasskeyRequest,
  PasskeyRegisterOptionsRequest,
  RecordId,
  UpdateAccountRequest,
} from "@ulixops/shared";
import { type Request, Router } from "express";
import { audit } from "../audit";
import type { AuthService } from "../auth/service";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { clientIpOf, sessionOf } from "../http/guard";
import { liveSessions, revokeSessions, toSessionSummary } from "../users/sessions";

export function accountRouter(deps: { db: Db; now: () => Date; auth: AuthService }): Router {
  const { db, now, auth } = deps;
  const router = Router();
  const record = (req: Request, action: string, meta: Prisma.InputJsonObject = {}) =>
    audit(
      db,
      { userId: sessionOf(req).user.id, action, result: "success", ip: clientIpOf(req), meta },
      now(),
    );

  router.get("/", async (req, res) => {
    const { user, sessionId } = sessionOf(req);
    const account = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const sessions = await db.session.findMany({
      where: { userId: user.id, ...liveSessions(now()) },
      orderBy: { lastSeenAt: "desc" },
    });
    res.json({
      user: { id: account.id, email: account.email, name: account.name, role: account.role },
      twoFactorEnabled: account.twoFactorEnabled,
      sessions: sessions.map((s) => toSessionSummary(s, sessionId)),
      passkeys: await auth.listPasskeys(user.id),
    });
  });

  router.patch("/", async (req, res) => {
    const body = UpdateAccountRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    await db.user.update({ where: { id: user.id }, data: { name: body.data.name || null } });
    await record(req, "account.update", { fields: ["name"] });
    res.json({ ok: true });
  });

  router.post("/passkeys/options", async (req, res) => {
    const body = PasskeyRegisterOptionsRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const result = await auth.passkeyRegistrationOptions(
      sessionOf(req).user.id,
      body.data.code,
      body.data.context,
    );
    if (result.ok) res.json(result.value);
    else res.status(result.error === "rate_limited" ? 429 : 401).json({ error: result.error });
  });

  router.post("/passkeys", async (req, res) => {
    const body = AddPasskeyRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const result = await auth.addPasskey(
      sessionOf(req).user.id,
      body.data.name,
      body.data.credential,
      clientIpOf(req),
    );
    if (result.ok) res.status(201).json(result.value);
    else res.status(422).json({ error: result.error });
  });

  router.post("/passkeys/:passkeyId/remove", async (req, res) => {
    const passkeyId = RecordId.safeParse(req.params.passkeyId);
    const result = passkeyId.success
      ? await auth.removePasskey(sessionOf(req).user.id, passkeyId.data, clientIpOf(req))
      : null;
    if (result?.ok) res.json(result.value);
    else res.status(404).json({ error: "not_found" });
  });

  router.post("/sessions/:sessionId/revoke", async (req, res) => {
    const sessionId = RecordId.safeParse(req.params.sessionId);
    const ended = sessionId.success
      ? await revokeSessions(db, { id: sessionId.data, userId: sessionOf(req).user.id }, now())
      : 0;
    if (ended === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await record(req, "session.revoke", { sessionId: sessionId.data });
    res.json({ ok: true });
  });

  router.post("/sessions/revoke-others", async (req, res) => {
    const { user, sessionId } = sessionOf(req);
    const ended = await revokeSessions(db, { userId: user.id, id: { not: sessionId } }, now());
    await record(req, "session.revoke_others", { sessionsEnded: ended });
    res.json({ ok: true });
  });

  return router;
}
