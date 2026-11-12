// Visual check endpoints (P4-3, A163): Monitoring → Visual checks, site tab, image GETs.
import {
  EnvKind,
  RecordId,
  type VisualCheckView,
  type VisualOverview,
  VisualCheckSettings,
} from "@ulixops/shared";
import { Router } from "express";
import { audit } from "../audit";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { runManualVisualCheck, toCheckView, toListItem, type VisualDeps } from "./service";
import { readVisualSettings, writeVisualSettings } from "./settings";

const checkInclude = {
  environment: { include: { site: { select: { id: true, name: true } } } },
  pages: true,
} as const;

/** /sites/:id/visual-checks and /sites/:id/environments/:kind/visual-check */
export function siteVisualRouter(deps: VisualDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const guard = { db, now };

  router.get("/:id/visual-checks", authorize("sites.view", guard), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rows = await db.visualCheck.findMany({
      where: { environment: { siteId: id.data } },
      orderBy: { startedAt: "desc" },
      take: 30,
      include: checkInclude,
    });
    res.json({ checks: rows.map((r) => toListItem(r)) });
  });

  router.post(
    "/:id/environments/:kind/visual-check",
    authorize("sites.refresh", guard),
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
      const started = await runManualVisualCheck(deps, env, {
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

/** /visual-checks: overview, detail, settings, PNG. */
export function visualRouter(deps: VisualDeps): Router {
  const { db, store, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", { db, now });
  const canManage = authorize("settings.manage", { db, now });

  router.get("/overview", canView, async (_req, res) => {
    const settings = await readVisualSettings(db);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [recent, changedOpen, checkedToday] = await Promise.all([
      db.visualCheck.findMany({
        where: { status: { in: ["CLEAN", "CHANGED", "FAILED", "SKIPPED"] } },
        orderBy: { startedAt: "desc" },
        take: 50,
        include: checkInclude,
      }),
      db.visualCheck.count({ where: { status: "CHANGED" } }),
      db.visualCheck.count({
        where: {
          finishedAt: { gte: startOfDay },
          status: { in: ["CLEAN", "CHANGED", "FAILED"] },
        },
      }),
    ]);
    const body: VisualOverview = {
      recent: recent.map((r) => toListItem(r)),
      changedOpen,
      checkedToday,
      settings,
    };
    res.json(body);
  });

  router.get("/settings", canView, async (_req, res) => {
    res.json(await readVisualSettings(db));
  });

  router.put("/settings", canManage, async (req, res) => {
    const parsed = VisualCheckSettings.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const before = await readVisualSettings(db);
    const after = await writeVisualSettings(db, parsed.data, sessionOf(req).user.id);
    await audit(
      db,
      {
        action: "settings.visual_check",
        userId: sessionOf(req).user.id,
        ip: clientIpOf(req),
        result: "success",
        meta: { before, after },
      },
      deps.now(),
    );
    res.json(after);
  });

  router.get("/:id", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const row = await db.visualCheck.findUnique({
      where: { id: id.data },
      include: checkInclude,
    });
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body: VisualCheckView = toCheckView(row);
    res.json(body);
  });

  router.get("/:id/pages/:slug/:kind", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const slug = String(req.params.slug ?? "");
    const kind = String(req.params.kind ?? "").replace(/\.png$/i, "");
    if (
      !id.success ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(slug) ||
      !["before", "after", "diff"].includes(kind)
    ) {
      res.status(404).end();
      return;
    }
    const file = `${slug}-${kind}.png`;
    if (!(await store.exists(id.data, file))) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    store.open(id.data, file).pipe(res);
  });

  return router;
}
