// Monitoring endpoints (Phase 3, spec screen 16 and the site "Uptime & SSL" tab). P3-1: SSL
// certificates and domain expiry (A148). P3-2: uptime (A149).
import {
  type CertificateView,
  type ExpiryOverview,
  PublicHostname,
  RecordId,
  SetDomainExpiry,
  SetUptimeEnabled,
  type SiteExpiryView,
  type SiteUptimeView,
  UPTIME_INTERVAL_MS,
  type UptimeOverview,
} from "@ulixops/shared";
import { audit } from "../audit";
import { Router } from "express";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { activeSiteWhereForUser } from "../sites/access";
import {
  certificateView,
  domainViews,
  type ExpiryDeps,
  readExpiryStatus,
  setManualDomainExpiry,
  startExpiryCheck,
} from "./expiry";
import {
  endMonitoring,
  readUptimeStatus,
  recentIncidents,
  startUptimeCheck,
  uptimeHours,
  uptimeSiteView,
  uptimeWindows,
} from "./uptime";

const INTERVAL_MINUTES = UPTIME_INTERVAL_MS / 60_000;
const viewInclude = {
  site: { select: { id: true, name: true } },
  uptimeMonitor: true,
} as const;

/** /sites/:id/expiry, /sites/:id/expiry-check, /sites/:id/uptime, /sites/:id/uptime-check */
export function siteMonitoringRouter(deps: ExpiryDeps): Router {
  const { db, now } = deps;
  const router = Router();

  router.get("/:id/expiry", authorize("sites.view", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const envs = id.success
      ? await db.siteEnvironment.findMany({
          where: { siteId: id.data },
          include: { site: { select: { id: true, name: true } }, sslCertificate: true },
          orderBy: { kind: "asc" },
        })
      : [];
    if (envs.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const at = now();
    const certificates = envs.flatMap((env) =>
      env.sslCertificate ? [certificateView(env, env.sslCertificate, at)] : [],
    );
    const body: SiteExpiryView = {
      status: await readExpiryStatus(db),
      certificates,
      domains: await domainViews(db, certificates, at),
    };
    res.json(body);
  });

  router.post("/:id/expiry-check", authorize("sites.refresh", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const site = id.success ? await db.site.findUnique({ where: { id: id.data } }) : null;
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (site.archived) {
      res.status(409).json({ error: "site_archived" });
      return;
    }
    const started = startExpiryCheck(
      deps,
      { userId: sessionOf(req).user.id, ip: clientIpOf(req) },
      site.id,
    );
    if (!started.ok) {
      res.status(409).json({ error: started.error });
      return;
    }
    res.status(202).json({ ok: true });
  });

  router.get("/:id/uptime", authorize("sites.view", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const site = id.success ? await db.site.findUnique({ where: { id: id.data } }) : null;
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const at = now();
    const env = await db.siteEnvironment.findUnique({
      where: { siteId_kind: { siteId: site.id, kind: "PRODUCTION" } },
      include: viewInclude,
    });
    const incidents = env ? await recentIncidents(db, at, { environmentId: env.id }, 50) : [];
    const open = env
      ? await db.uptimeIncident.findFirst({ where: { environmentId: env.id, endedAt: null } })
      : null;
    const body: SiteUptimeView = {
      status: await readUptimeStatus(db),
      intervalMinutes: INTERVAL_MINUTES,
      monitor: env
        ? uptimeSiteView(
            env,
            (await uptimeWindows(db, [env.id], at)).get(env.id),
            open ?? undefined,
          )
        : null,
      hours: env ? await uptimeHours(db, env.id, at) : [],
      incidents,
    };
    res.json(body);
  });

  router.post("/:id/uptime-check", authorize("sites.refresh", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const site = id.success ? await db.site.findUnique({ where: { id: id.data } }) : null;
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (site.archived) {
      res.status(409).json({ error: "site_archived" });
      return;
    }
    const started = await startUptimeCheck(
      deps,
      { userId: sessionOf(req).user.id, ip: clientIpOf(req) },
      site.id,
    );
    if (!started.ok) {
      res.status(409).json({ error: started.error });
      return;
    }
    res.status(202).json({ ok: true });
  });

  /** Pause or resume uptime monitoring of the production site (A149). */
  router.put("/:id/uptime", authorize("settings.manage", deps), async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const body = SetUptimeEnabled.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const env = await db.siteEnvironment.findUnique({
      where: { siteId_kind: { siteId: id.data, kind: "PRODUCTION" } },
    });
    if (!env) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const at = now();
    await db.siteEnvironment.update({
      where: { id: env.id },
      data: { uptimeEnabled: body.data.enabled },
    });
    if (!body.data.enabled) await endMonitoring(db, env.id, at);
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "site.uptime.monitoring",
        result: "success",
        ip: clientIpOf(req),
        siteIds: [id.data],
        meta: { enabled: body.data.enabled },
      },
      at,
    );
    res.json({ ok: true });
  });

  return router;
}

/** /monitoring: every site's uptime, certificates and domains; manual domain expiry. */
export function monitoringRouter(deps: ExpiryDeps): Router {
  const { db, now } = deps;
  const router = Router();

  router.get("/expiry", authorize("sites.view", deps), async (req, res) => {
    const siteScope = activeSiteWhereForUser(sessionOf(req).user);
    const envs = await db.siteEnvironment.findMany({
      where: { site: siteScope },
      include: { site: { select: { id: true, name: true } }, sslCertificate: true },
      orderBy: [{ site: { name: "asc" } }, { kind: "asc" }],
    });
    const at = now();
    const certificates: CertificateView[] = [];
    const unchecked: ExpiryOverview["unchecked"] = [];
    for (const env of envs) {
      if (env.sslCertificate) certificates.push(certificateView(env, env.sslCertificate, at));
      else
        unchecked.push({
          siteId: env.site.id,
          siteName: env.site.name,
          environment: env.kind,
          url: env.url,
        });
    }
    const body: ExpiryOverview = {
      status: await readExpiryStatus(db),
      certificates,
      domains: await domainViews(db, certificates, at),
      unchecked,
    };
    res.json(body);
  });

  router.get("/uptime", authorize("sites.view", deps), async (req, res) => {
    const at = now();
    const siteScope = activeSiteWhereForUser(sessionOf(req).user);
    const envs = await db.siteEnvironment.findMany({
      where: { kind: "PRODUCTION", site: siteScope },
      include: viewInclude,
      orderBy: { site: { name: "asc" } },
    });
    const ids = envs.map((e) => e.id);
    const [windows, open, incidents] = await Promise.all([
      uptimeWindows(db, ids, at),
      db.uptimeIncident.findMany({ where: { environmentId: { in: ids }, endedAt: null } }),
      recentIncidents(db, at, { environment: { site: siteScope } }),
    ]);
    const openOf = new Map(open.map((i) => [i.environmentId, i]));
    const body: UptimeOverview = {
      status: await readUptimeStatus(db),
      intervalMinutes: INTERVAL_MINUTES,
      sites: envs.map((env) => uptimeSiteView(env, windows.get(env.id), openOf.get(env.id))),
      incidents,
    };
    res.json(body);
  });

  router.put("/domains/:domain/expiry", authorize("settings.manage", deps), async (req, res) => {
    const domain = PublicHostname.safeParse(String(req.params.domain ?? ""));
    const body = SetDomainExpiry.safeParse(req.body);
    if (!domain.success || !body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const done = await setManualDomainExpiry(deps, domain.data, body.data.expiresAt, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    res.status(done.ok ? 200 : 404).json(done.ok ? { ok: true } : { error: "not_found" });
  });

  return router;
}
