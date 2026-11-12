// File integrity endpoints (Phase 2 step 4, A144): site Security tab, Security → File integrity,
// one check's details, and known-safe rules.
import {
  EnvKind,
  type IntegrityCheckDetail,
  type IntegrityCheckList,
  type IntegrityOverview,
  type IntegritySiteRow,
  MarkMalwareSafe,
  RecordId,
} from "@ulixops/shared";
import { Router } from "express";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { emailsOf, readSchedule } from "../malware/service";
import { activeSiteWhereForUser, canAccessSite } from "../sites/access";
import {
  checkInclude,
  checkViews,
  expireStaleChecks,
  type IntegrityDeps,
  markChangeSafe,
  removeChangeRule,
  startIntegrityCheck,
} from "./service";

/** /sites/:id/integrity-checks and /sites/:id/environments/:kind/integrity-check */
export function siteIntegrityRouter(deps: IntegrityDeps): Router {
  const { db, now } = deps;
  const router = Router();

  router.get("/:id/integrity-checks", authorize("sites.view", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await expireStaleChecks(db, now());
    const rows = await db.integrityCheck.findMany({
      where: { environment: { siteId: id.data } },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: checkInclude(true),
    });
    const body: IntegrityCheckList = { checks: await checkViews(db, rows) };
    res.json(body);
  });

  router.post(
    "/:id/environments/:kind/integrity-check",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const id = RecordId.safeParse(req.params.id);
      const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
      const env =
        id.success && kind.success
          ? await db.siteEnvironment.findFirst({
              where: { siteId: id.data, kind: kind.data },
              include: { site: { select: { id: true, name: true, archived: true } } },
            })
          : null;
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (env.site.archived) {
        res.status(409).json({ error: "site_archived" });
        return;
      }
      const started = await startIntegrityCheck(deps, env, {
        userId: sessionOf(req).user.id,
        ip: clientIpOf(req),
      });
      if (!started.ok) {
        res.status(409).json({ error: started.error });
        return;
      }
      res.status(202).json({ checkId: started.checkId });
    },
  );

  return router;
}

/** /integrity-checks: overview, one check, known-safe rules. */
export function integrityRouter(deps: IntegrityDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canManage = authorize("settings.manage", deps);

  router.get("/overview", canView, async (req, res) => {
    await expireStaleChecks(db, now());
    const siteScope = activeSiteWhereForUser(sessionOf(req).user);
    const [schedule, envs] = await Promise.all([
      readSchedule(db),
      db.siteEnvironment.findMany({
        where: { site: siteScope },
        include: { site: { select: { id: true, name: true } } },
        orderBy: [{ site: { name: "asc" } }, { kind: "asc" }],
      }),
    ]);
    const ids = envs.map((e) => e.id);
    const [last, running] = await Promise.all([
      db.integrityCheck.findMany({
        where: { environmentId: { in: ids }, status: { in: ["CLEAN", "CHANGED", "FAILED"] } },
        orderBy: { startedAt: "desc" },
        distinct: ["environmentId"],
        include: { _count: { select: { findings: { where: { ignored: false } } } } },
      }),
      db.integrityCheck.findMany({
        where: { environmentId: { in: ids }, status: "RUNNING" },
        select: { id: true, environmentId: true },
      }),
    ]);
    const lastBy = new Map(last.map((c) => [c.environmentId, c]));
    const runningBy = new Map(running.map((c) => [c.environmentId, c.id]));
    const sites: IntegritySiteRow[] = envs.map((env) => {
      const l = lastBy.get(env.id);
      return {
        siteId: env.site.id,
        siteName: env.site.name,
        environment: env.kind,
        ready: Boolean(env.hostKey),
        autoScan: env.malwareAutoScan,
        last: l
          ? {
              id: l.id,
              status: l.status as "CLEAN" | "CHANGED" | "FAILED",
              at: (l.finishedAt ?? l.startedAt).toISOString(),
              findingCount: l._count.findings,
              unverifiable: l.unverifiable.length,
            }
          : null,
        running: runningBy.get(env.id) ?? null,
      };
    });
    const lastFinished = last.reduce<Date | null>(
      (max, c) => (c.finishedAt && (!max || c.finishedAt > max) ? c.finishedAt : max),
      null,
    );
    const body: IntegrityOverview = {
      automatic: schedule.enabled && schedule.integrityEnabled,
      sites,
      stats: {
        changed: sites.filter((s) => s.last?.status === "CHANGED").length,
        clean: sites.filter((s) => s.last?.status === "CLEAN").length,
        failed: sites.filter((s) => s.last?.status === "FAILED").length,
        neverChecked: sites.filter((s) => !s.last).length,
        lastFinishedAt: lastFinished?.toISOString() ?? null,
      },
    };
    res.json(body);
  });

  router.post("/findings/:id/safe", canManage, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const body = MarkMalwareSafe.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const done = await markChangeSafe(deps, id.data, body.data.reason, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    res.status(done.ok ? 200 : 404).json(done.ok ? { ok: true } : { error: "not_found" });
  });

  router.delete("/ignores/:id", canManage, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const done = await removeChangeRule(deps, id.data, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    res.status(done.ok ? 200 : 404).json(done.ok ? { ok: true } : { error: "not_found" });
  });

  router.get("/:id", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const row = id.success
      ? await db.integrityCheck.findUnique({ where: { id: id.data }, include: checkInclude(true) })
      : null;
    if (!row || !canAccessSite(sessionOf(req).user, row.environment.site)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rules = await db.integrityIgnore.findMany({
      where: { environmentId: row.environmentId },
      orderBy: { createdAt: "desc" },
    });
    const emails = await emailsOf(
      db,
      rules.map((r) => r.createdById),
    );
    const [check] = await checkViews(db, [row]);
    if (!check) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body: IntegrityCheckDetail = {
      check,
      ignores: rules.map((r) => ({
        id: r.id,
        scope: r.scope as "core" | "plugin",
        component: r.component,
        path: r.path,
        reason: r.reason,
        createdBy: emails.get(r.createdById) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    res.json(body);
  });

  return router;
}
