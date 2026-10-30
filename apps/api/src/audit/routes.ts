import { type AuditEntry, AuditQuery, type AuditPage } from "@ulixops/shared";
import { type Request, Router } from "express";
import { audit } from "../audit";
import { normalizeEmail } from "../auth/service";
import type { Db } from "../db";
import type { AuditLog, Prisma } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_LIMIT = 10_000;

/** Filters → Prisma where; null when the email filter matches no user (an empty result). */
async function whereFor(db: Db, q: AuditQuery): Promise<Prisma.AuditLogWhereInput | null> {
  const where: Prisma.AuditLogWhereInput = {};
  if (q.action) where.action = { startsWith: q.action };
  if (q.result) where.result = q.result;
  if (q.email) {
    const user = await db.user.findUnique({ where: { email: normalizeEmail(q.email) } });
    if (!user) return null;
    where.userId = user.id;
  }
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
      ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + DAY_MS) } : {}),
    };
  }
  return where;
}

async function withUsers(db: Db, rows: AuditLog[]): Promise<AuditEntry[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
  const users = new Map(
    (await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })).map(
      (u) => [u.id, u],
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    result: row.result,
    ip: row.ip,
    siteIds: row.siteIds,
    meta: row.meta,
    user: row.userId ? (users.get(row.userId) ?? null) : null,
  }));
}

/** CSV cell, with spreadsheet formula injection neutralised (=, +, -, @ at the start). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Read-only view of the audit log for Admins. There is deliberately no write or delete route. */
export function auditRouter(deps: { db: Db; now: () => Date }): Router {
  const { db } = deps;
  const router = Router();
  router.use(authorize("audit.view", deps));

  async function parse(req: Request) {
    const q = AuditQuery.safeParse(req.query);
    return q.success ? { q: q.data, where: await whereFor(db, q.data) } : null;
  }

  router.get("/", async (req, res) => {
    const parsed = await parse(req);
    if (!parsed) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { q, where } = parsed;
    if (!where) {
      res.json({ entries: [], nextCursor: null } satisfies AuditPage);
      return;
    }
    const rows = await db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    const nextCursor = rows.length > q.limit ? (page.at(-1)?.id ?? null) : null;
    res.json({ entries: await withUsers(db, page), nextCursor } satisfies AuditPage);
  });

  router.get("/export", async (req, res) => {
    const parsed = await parse(req);
    if (!parsed) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const rows = parsed.where
      ? await db.auditLog.findMany({
          where: parsed.where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: EXPORT_LIMIT,
        })
      : [];
    const entries = await withUsers(db, rows);
    const lines = [
      ["time_utc", "user", "action", "result", "ip", "sites", "details"].join(","),
      ...entries.map((e) =>
        [
          e.createdAt,
          e.user?.email ?? "system",
          e.action,
          e.result,
          e.ip ?? "",
          e.siteIds.join(" "),
          e.meta == null ? "" : JSON.stringify(e.meta),
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    const { action, email, result, from, to } = parsed.q;
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "audit.export",
        result: "success",
        ip: clientIpOf(req),
        meta: { rows: entries.length, filters: { action, email, result, from, to } },
      },
      deps.now(),
    );
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="ulixops-audit-log.csv"');
    res.send(`${lines.join("\r\n")}\r\n`);
  });

  return router;
}

/** Recent security alerts for the dashboard (Admins). */
export function alertsRouter(deps: { db: Db; now: () => Date }): Router {
  const { db } = deps;
  const router = Router();
  router.use(authorize("audit.view", deps));
  router.get("/", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const rows = await db.securityAlert.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    const ids = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    const users = new Map(
      (
        await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
      ).map((u) => [u.id, u]),
    );
    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        createdAt: r.createdAt.toISOString(),
        ip: r.ip,
        user: r.userId ? (users.get(r.userId) ?? null) : null,
      })),
    });
  });
  return router;
}
