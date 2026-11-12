// PHP error log viewer routes (A159). Viewing: sites.view; reading now over SSH: sites.refresh.
import {
  BulkLoggingRequest,
  can,
  ERRORLOG_EVERY_MS,
  type ErrorLogOverview,
  RecordId,
  SetLoggingRequest,
} from "@ulixops/shared";
import { decideApproval, requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { Router } from "express";
import { z } from "zod";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { activeSiteWhereForUser } from "../sites/access";
import { callRunner } from "../sites/routes";
import {
  type ErrorLogDeps,
  errorLogRow,
  errorLogView,
  enableLoggingBulk,
  isCollecting,
  readSiteErrorLog,
  setLogging,
} from "./service";

const Kind = z
  .enum(["production", "staging"])
  .transform((k) => k.toUpperCase() as "PRODUCTION" | "STAGING");

/** GET /monitoring/php-errors: every environment's latest reading, worst first. */
export function errorLogRouter(deps: ErrorLogDeps): Router {
  const { db } = deps;
  const router = Router();
  router.get("/", authorize("sites.view", deps), async (req, res) => {
    const envs = await db.siteEnvironment.findMany({
      where: { site: activeSiteWhereForUser(sessionOf(req).user) },
      include: { site: { select: { id: true, name: true } }, phpErrorLog: true },
    });
    const rows = envs
      .filter((e) => e.kind === "PRODUCTION" || e.phpErrorLog)
      .map((e) => errorLogRow(e, e.phpErrorLog))
      .sort(
        (a, b) =>
          b.fatal24h - a.fatal24h ||
          b.errors24h - a.errors24h ||
          b.warnings24h - a.warnings24h ||
          a.siteName.localeCompare(b.siteName),
      );
    const body: ErrorLogOverview = {
      rows,
      running: isCollecting(),
      everyHours: ERRORLOG_EVERY_MS / 3_600_000,
    };
    res.json(body);
  });

  /** Switch logging on for several sites: a bulk config change, so a second Admin approves. */
  router.post("/logging-bulk", authorize("sites.manage", deps), async (req, res) => {
    const body = BulkLoggingRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const envs = await db.siteEnvironment.findMany({
      where: {
        id: { in: body.data.environmentIds },
        hostKey: { not: null },
        site: { archived: false },
      },
      include: { site: { select: { name: true } } },
    });
    if (envs.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const user = sessionOf(req).user;
    const ip = clientIpOf(req);
    const approvalDeps = {
      db,
      now: deps.now,
      notifier: deps.notifier,
      onDebugLogBulkApproved: (ids: string[], requestedById: string) =>
        void enableLoggingBulk(deps, ids, requestedById),
    };
    const asked = await requestApproval(
      db,
      {
        action: "site.debuglog.bulk",
        payload: {
          siteId: "",
          kind: "bulk",
          environmentIds: envs.map((e) => e.id),
          siteNames: envs.map((e) => `${e.site.name}${e.kind === "STAGING" ? " (staging)" : ""}`),
        },
        requestedById: user.id,
        ip,
        requesterRole: user.role,
      },
      deps.now(),
      deps.notifier,
    );
    // Stuck PENDING from an earlier click: a Super Admin (A134) approves that request now
    // instead of getting "already waiting" (owner hit this on PHP errors bulk switch).
    if (!asked.ok) {
      if (asked.error === "already_pending" && can(user.role, "approvals.self")) {
        const pending = await db.approvalRequest.findFirst({
          where: {
            action: "site.debuglog.bulk",
            status: "PENDING",
            AND: [
              { payload: { path: ["siteId"], equals: "" } },
              { payload: { path: ["kind"], equals: "bulk" } },
            ],
          },
        });
        if (pending) {
          const decided = await decideApproval(approvalDeps, pending, user, "APPROVED", {
            comment: null,
            ip,
          });
          if (decided.ok) {
            const ids = (pending.payload as { environmentIds?: unknown } | null)?.environmentIds;
            const count = Array.isArray(ids)
              ? ids.filter((v): v is string => typeof v === "string").length
              : envs.length;
            res.status(202).json({ requestId: pending.id, selfApproved: true, count });
            return;
          }
        }
      }
      res.status(409).json({ error: asked.error });
      return;
    }
    const selfApproved = await selfApproveIfAllowed(approvalDeps, asked.id, user, ip);
    res.status(202).json({ requestId: asked.id, selfApproved, count: envs.length });
  });
  return router;
}

/** /sites/:id/php-errors?kind= (view) and /sites/:id/environments/:kind/php-errors (read now). */
export function siteErrorLogRouter(deps: ErrorLogDeps): Router {
  const { db } = deps;
  const router = Router();

  const envOf = async (siteId: unknown, kind: unknown) => {
    const id = RecordId.safeParse(siteId);
    const k = Kind.safeParse(kind ?? "production");
    if (!id.success || !k.success) return null;
    return db.siteEnvironment.findUnique({
      where: { siteId_kind: { siteId: id.data, kind: k.data } },
      include: { site: { select: { id: true, name: true, archived: true } }, phpErrorLog: true },
    });
  };

  router.get("/:id/php-errors", authorize("sites.view", deps), async (req, res) => {
    const env = await envOf(req.params.id, req.query.kind);
    if (!env) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(errorLogView(env, env.phpErrorLog));
  });

  router.post(
    "/:id/environments/:kind/php-errors",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (env.site.archived) {
        res.status(409).json({ error: "site_archived" });
        return;
      }
      if (!env.hostKey) {
        res.status(409).json({ error: "connection_untested" });
        return;
      }
      const row = await callRunner(res, () =>
        readSiteErrorLog(deps, env, { userId: sessionOf(req).user.id, ip: clientIpOf(req) }),
      );
      if (row === null) return;
      res.json(errorLogView(env, row));
    },
  );

  /** Switch PHP error logging on or off for one environment (Admin; audited). */
  router.post(
    "/:id/environments/:kind/debug-log",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      const body = SetLoggingRequest.safeParse(req.body);
      if (!env || !body.success) {
        res.status(env ? 400 : 404).json({ error: env ? "bad_request" : "not_found" });
        return;
      }
      if (env.site.archived) {
        res.status(409).json({ error: "site_archived" });
        return;
      }
      const result = await callRunner(res, () =>
        setLogging(deps, env, body.data.enabled, {
          userId: sessionOf(req).user.id,
          ip: clientIpOf(req),
        }),
      );
      if (result === null) return;
      if (!result.ok && result.error !== "logging_failed") {
        res.status(409).json({ error: result.error });
        return;
      }
      // Refused by the site (e.g. a downloadable log): 200 with the reason to show.
      res.json(
        result.ok
          ? { ok: true, exposed: false, detail: result.detail }
          : { ok: false, exposed: result.exposed, detail: result.detail },
      );
    },
  );
  return router;
}
