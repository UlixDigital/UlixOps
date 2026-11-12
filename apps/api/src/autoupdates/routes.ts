// Scheduled updates routes (A162). Viewing: sites.view. Window, skip list, switching off and
// clearing a hold: sites.manage (Admin), audited. Switching on: an ApprovalRequest.
import {
  AutoUpdateEnableRequest,
  AutoUpdateHoldClearRequest,
  type AutoUpdateOverview,
  AutoUpdateSettingsRequest,
  RecordId,
} from "@ulixops/shared";
import { Router } from "express";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import {
  type AutoUpdateDeps,
  autoUpdateOverview,
  autoUpdateView,
  clearHold,
  disable,
  isAutoUpdating,
  requestEnable,
  saveSettings,
} from "./service";

/** /auto-updates: every site's schedule, and switching on for one or many sites. */
export function autoUpdatesRouter(deps: AutoUpdateDeps): Router {
  const router = Router();
  router.get("/", authorize("sites.view", deps), async (_req, res) => {
    const body: AutoUpdateOverview = {
      rows: await autoUpdateOverview(deps),
      running: isAutoUpdating(),
    };
    res.json(body);
  });

  router.post("/enable", authorize("sites.manage", deps), async (req, res) => {
    const body = AutoUpdateEnableRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const result = await requestEnable(
      deps,
      [...new Set(body.data.siteIds)],
      body.data.window,
      sessionOf(req).user,
      clientIpOf(req),
    );
    if (!result.ok) {
      res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error });
      return;
    }
    res.status(202).json(result);
  });
  return router;
}

/** /sites/:id/auto-updates */
export function siteAutoUpdateRouter(deps: AutoUpdateDeps): Router {
  const { db } = deps;
  const router = Router();

  const siteOf = async (raw: unknown) => {
    const id = RecordId.safeParse(raw);
    if (!id.success) return null;
    return db.site.findFirst({ where: { id: id.data }, include: { environments: true } });
  };

  router.get("/:id/auto-updates", authorize("sites.view", deps), async (req, res) => {
    const site = await siteOf(req.params.id);
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(await autoUpdateView(deps, site));
  });

  router.put("/:id/auto-updates", authorize("sites.manage", deps), async (req, res) => {
    const body = AutoUpdateSettingsRequest.safeParse(req.body);
    const site = await siteOf(req.params.id);
    if (!site || !body.success) {
      res.status(site ? 400 : 404).json({ error: site ? "bad_request" : "not_found" });
      return;
    }
    if (site.archived) {
      res.status(409).json({ error: "site_archived" });
      return;
    }
    await saveSettings(deps, site.id, body.data, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    res.json(await autoUpdateView(deps, site));
  });

  router.post("/:id/auto-updates/disable", authorize("sites.manage", deps), async (req, res) => {
    const site = await siteOf(req.params.id);
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await disable(deps, site.id, { userId: sessionOf(req).user.id, ip: clientIpOf(req) });
    res.json(await autoUpdateView(deps, site));
  });

  router.post(
    "/:id/auto-updates/holds/clear",
    authorize("sites.manage", deps),
    async (req, res) => {
      const body = AutoUpdateHoldClearRequest.safeParse(req.body);
      const site = await siteOf(req.params.id);
      if (!site || !body.success) {
        res.status(site ? 400 : 404).json({ error: site ? "bad_request" : "not_found" });
        return;
      }
      const cleared = await clearHold(deps, site.id, body.data, {
        userId: sessionOf(req).user.id,
        ip: clientIpOf(req),
      });
      if (!cleared) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await autoUpdateView(deps, site));
    },
  );
  return router;
}
