import type { Db } from "./db";
import type { Prisma } from "./generated/prisma/client";

export interface AuditEntry {
  userId?: string | null;
  action: string;
  result: string;
  ip?: string | null;
  siteIds?: string[];
  meta?: Prisma.InputJsonValue;
}

/**
 * Appends one audit row. Never put secrets (passwords, tokens, codes) in `meta`.
 * Step 3 adds the database role that makes this table insert-only.
 */
export async function audit(db: Db, entry: AuditEntry, at: Date): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      result: entry.result,
      ip: entry.ip ?? null,
      siteIds: entry.siteIds ?? [],
      meta: entry.meta,
      createdAt: at,
    },
  });
}
