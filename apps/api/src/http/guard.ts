// Authentication and authorization for API routes that act on behalf of a signed-in user.
import { can, type Permission, type SessionInfo } from "@ulixops/shared";
import type { NextFunction, Request, Response } from "express";
import { audit } from "../audit";
import type { AuthService } from "../auth/service";
import type { Db } from "../db";

const sessions = new WeakMap<Request, SessionInfo>();

/** The session that `authenticate` attached to this request. */
export function sessionOf(req: Request): SessionInfo {
  const session = sessions.get(req);
  if (!session) throw new Error("authenticate() must run before this handler");
  return session;
}

/** The visitor's IP as forwarded by the web app (the only caller on the internal network). */
export function clientIpOf(req: Request): string | null {
  const ip = req.get("x-ulix-client-ip");
  return ip && ip.length <= 64 ? ip : null;
}

/** Requires `Authorization: Bearer <session token>` and a valid, unexpired session. */
export function authenticate(auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "")?.[1];
    if (!token) {
      res.status(401).json({ error: "session_invalid" });
      return;
    }
    // The web app marks background polls as passive: they must not reset the idle timer.
    const result = await auth.validateSession(token, {
      touch: req.get("x-ulix-passive") !== "1",
    });
    if (!result.ok) {
      res.status(401).json({ error: result.error });
      return;
    }
    sessions.set(req, result.value);
    next();
  };
}

/** Allows the request only if the user's role has `permission`; refusals are audited. */
export function authorize(permission: Permission, deps: { db: Db; now: () => Date }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await permitted(req, res, permission, deps)) next();
  };
}

/**
 * The same check for a permission that depends on the request (e.g. which environment).
 * Answers 403 and audits the refusal when the role lacks it.
 */
export async function permitted(
  req: Request,
  res: Response,
  permission: Permission,
  deps: { db: Db; now: () => Date },
): Promise<boolean> {
  const { user } = sessionOf(req);
  if (can(user.role, permission)) return true;
  await audit(
    deps.db,
    {
      userId: user.id,
      action: "rbac.denied",
      result: "denied",
      ip: clientIpOf(req),
      meta: { permission, method: req.method, path: req.originalUrl.split("?")[0] ?? "" },
    },
    deps.now(),
  );
  res.status(403).json({ error: "forbidden" });
  return false;
}
