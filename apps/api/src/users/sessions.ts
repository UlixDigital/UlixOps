import type { SessionSummary, UserSummary } from "@ulixops/shared";
import { POLICY } from "../auth/policy";
import type { Db } from "../db";
import type { Prisma, Session, User } from "../generated/prisma/client";

/** Sessions that would still pass validation right now (not revoked, expired or idle). */
export function liveSessions(now: Date): Prisma.SessionWhereInput {
  return {
    revokedAt: null,
    expiresAt: { gt: now },
    lastSeenAt: { gt: new Date(now.getTime() - POLICY.idleMs) },
  };
}

export function toSessionSummary(
  session: Session,
  currentSessionId: string | null,
): SessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ip: session.ip,
    userAgent: session.userAgent,
    current: session.id === currentSessionId,
  };
}

export function toUserSummary(user: User, activeSessions: number): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    twoFactorEnabled: user.twoFactorEnabled,
    setupPending: user.passwordHash === null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    activeSessions,
  };
}

/** Ends sessions now; returns how many were still open. */
export async function revokeSessions(db: Db, where: Prisma.SessionWhereInput, now: Date) {
  const result = await db.session.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count;
}
