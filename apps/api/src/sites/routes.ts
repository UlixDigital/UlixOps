// Site registry (spec 6.1, screens 3-5): add, edit, archive, and "Test connection" via the runner.
import {
  CreateSiteRequest,
  type EnvironmentInput,
  EnvKind,
  type EnvironmentView,
  RecordId,
  SiteTestResult,
  type SiteView,
  UpdateSiteRequest,
  type UptimeSummary,
  type VulnSummary,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { raiseAlert } from "../alerts";
import { requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Prisma, SiteEnvironment, SiteInventory } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { canAccessSite, siteWhereForUser } from "./access";
import { inventorySummary } from "./operations";
import { uptimeSummaries } from "../monitoring/uptime";
import { vulnSummaries } from "../vulnerabilities/routes";

export interface SitesDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

const withEnvironments = {
  environments: { orderBy: { kind: "asc" }, include: { inventory: true } },
} as const;
type SiteWithEnvironments = Prisma.SiteGetPayload<{ include: typeof withEnvironments }>;

function environmentView(
  env: SiteEnvironment & { inventory: SiteInventory | null },
  vulnerabilities?: VulnSummary,
  uptime?: UptimeSummary,
): EnvironmentView {
  return {
    kind: env.kind,
    url: env.url,
    sshHost: env.sshHost,
    sshPort: env.sshPort,
    sshUser: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
    lastTestAt: env.lastTestAt?.toISOString() ?? null,
    lastTestOk: env.lastTestOk,
    lastTestError: env.lastTestError,
    wpVersion: env.wpVersion,
    phpVersion: env.phpVersion,
    wpCliVersion: env.wpCliVersion,
    lastHealthAt: env.lastHealthAt?.toISOString() ?? null,
    lastHealthOk: env.lastHealthOk,
    lastHealthSummary: env.lastHealthSummary,
    inventory: env.inventory ? inventorySummary(env.inventory) : null,
    ...(vulnerabilities ? { vulnerabilities } : {}),
    ...(uptime ? { uptime } : {}),
    filesSftp: (() => {
      const authKind = env.filesSftpAuthKind === "password" ? "password" : "key";
      return {
        enabled: Boolean(env.filesSftpHost && env.filesSftpUser && env.filesSftpPath),
        host: env.filesSftpHost,
        port: env.filesSftpPort,
        user: env.filesSftpUser,
        path: env.filesSftpPath,
        authKind,
        credentialRef: authKind === "key" ? env.filesSftpCredentialRef : null,
        passwordSet: authKind === "password" && Boolean(env.filesSftpCredentialRef),
        hostKeyPinned: Boolean(env.filesSftpHostKey),
      };
    })(),
  };
}

/** Maps runner failures to API errors; their messages were already redacted by the runner. */
export async function callRunner<T>(res: Response, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RunnerUnavailableError) {
      res.status(504).json({ error: "runner_unavailable" });
      return null;
    }
    if (error instanceof RunnerJobFailedError) {
      res.status(502).json({ error: "runner_failed", detail: error.message });
      return null;
    }
    throw error;
  }
}

export function sitesRouter(deps: SitesDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canManage = authorize("sites.manage", deps);

  async function pendingCounts(siteIds: string[]) {
    const pending = await db.approvalRequest.findMany({
      where: { status: "PENDING" },
      select: { payload: true },
    });
    const counts = new Map<string, number>();
    for (const { payload } of pending) {
      const siteId = (payload as { siteId?: unknown } | null)?.siteId;
      if (typeof siteId === "string" && siteIds.includes(siteId))
        counts.set(siteId, (counts.get(siteId) ?? 0) + 1);
    }
    return counts;
  }

  async function views(sites: SiteWithEnvironments[]): Promise<SiteView[]> {
    const counts = await pendingCounts(sites.map((s) => s.id));
    const vulns = await vulnSummaries(
      db,
      sites.flatMap((s) => s.environments.map((e) => e.id)),
    );
    const uptime = await uptimeSummaries(
      db,
      sites.flatMap((s) => s.environments.filter((e) => e.kind === "PRODUCTION")),
      now(),
    );
    return sites.map((site) => ({
      id: site.id,
      name: site.name,
      url: site.url,
      host: site.host,
      tags: site.tags,
      archived: site.archived,
      createdAt: site.createdAt.toISOString(),
      environments: site.environments.map((env) =>
        environmentView(env, vulns.get(env.id), uptime.get(env.id)),
      ),
      pendingApprovals: counts.get(site.id) ?? 0,
    }));
  }

  async function load(req: Request, res: Response): Promise<SiteWithEnvironments | null> {
    const id = RecordId.safeParse(req.params.id);
    const site = id.success
      ? await db.site.findUnique({ where: { id: id.data }, include: withEnvironments })
      : null;
    if (!site || !canAccessSite(sessionOf(req).user, site)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return site;
  }

  const record = (
    req: Request,
    action: string,
    siteId: string,
    result: string,
    meta: Prisma.InputJsonObject = {},
  ) =>
    audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action,
        result,
        ip: clientIpOf(req),
        siteIds: [siteId],
        meta,
      },
      now(),
    );

  router.get("/", canView, async (req, res) => {
    const includeArchived = req.query.archived === "1";
    const scope = siteWhereForUser(sessionOf(req).user);
    const sites = await db.site.findMany({
      where: includeArchived ? scope : { AND: [scope, { archived: false }] },
      include: withEnvironments,
      orderBy: { name: "asc" },
    });
    res.json({ sites: await views(sites) });
  });

  router.post("/", canManage, async (req, res) => {
    const body = CreateSiteRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { name, host, tags, production, staging } = body.data;
    if (await db.site.findUnique({ where: { url: production.url } })) {
      res.status(409).json({ error: "url_taken" });
      return;
    }
    const envs = [
      { kind: "PRODUCTION" as const, ...production },
      ...(staging ? [{ kind: "STAGING" as const, ...staging }] : []),
    ];
    const site = await db.site.create({
      data: { name, url: production.url, host, tags, environments: { create: envs } },
      include: withEnvironments,
    });
    await record(req, "site.create", site.id, "success", {
      name,
      host,
      environments: envs.map((e) => e.kind),
    });
    const [view] = await views([site]);
    res.status(201).json(view);
  });

  router.get("/:id", canView, async (req, res) => {
    const site = await load(req, res);
    if (!site) return;
    const [view] = await views([site]);
    res.json(view);
  });

  router.patch("/:id", canManage, async (req, res) => {
    const body = UpdateSiteRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const site = await load(req, res);
    if (!site) return;
    const { name, host, tags, production, staging } = body.data;
    if (production && production.url !== site.url) {
      const taken = await db.site.findUnique({ where: { url: production.url } });
      if (taken && taken.id !== site.id) {
        res.status(409).json({ error: "url_taken" });
        return;
      }
    }

    const approvalsRequested: string[] = [];
    const changes: string[] = [];
    async function updateEnvironment(kind: EnvKind, input: EnvironmentInput) {
      const env = site?.environments.find((e) => e.kind === kind);
      if (!site) return;
      if (!env) {
        // A new environment is like registering a site: no approval needed.
        await db.siteEnvironment.create({ data: { siteId: site.id, kind, ...input } });
        changes.push(`${kind.toLowerCase()} added`);
        return;
      }
      await db.siteEnvironment.update({
        where: { id: env.id },
        data: { url: input.url, wpPath: input.wpPath },
      });
      const from = {
        sshHost: env.sshHost,
        sshPort: env.sshPort,
        sshUser: env.sshUser,
        credentialRef: env.credentialRef,
      };
      const to = {
        sshHost: input.sshHost,
        sshPort: input.sshPort,
        sshUser: input.sshUser,
        credentialRef: input.credentialRef,
      };
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        // Key, server or user: a second Admin must approve (agent decision A47).
        const { user } = sessionOf(req);
        const requested = await requestApproval(
          db,
          {
            action: "site.connection.change",
            payload: { siteId: site.id, kind, from, to },
            requestedById: user.id,
            ip: clientIpOf(req),
            requesterRole: user.role,
          },
          now(),
          deps.notifier,
        );
        const selfApproved =
          requested.ok &&
          (await selfApproveIfAllowed(
            { db, now, notifier: deps.notifier },
            requested.id,
            user,
            clientIpOf(req),
          ));
        approvalsRequested.push(
          !requested.ok
            ? `${kind.toLowerCase()} connection (already waiting)`
            : selfApproved
              ? `${kind.toLowerCase()} connection (self-approved, applied)`
              : `${kind.toLowerCase()} connection`,
        );
      }
    }

    await db.site.update({
      where: { id: site.id },
      data: {
        ...(name ? { name } : {}),
        ...(host ? { host } : {}),
        ...(tags ? { tags } : {}),
        ...(production ? { url: production.url } : {}),
      },
    });
    if (production) await updateEnvironment("PRODUCTION", production);
    if (staging) await updateEnvironment("STAGING", staging);
    if (staging === null && site.environments.some((e) => e.kind === "STAGING")) {
      await db.siteEnvironment.deleteMany({ where: { siteId: site.id, kind: "STAGING" } });
      changes.push("staging removed");
    }
    await record(req, "site.update", site.id, "success", {
      fields: Object.keys(body.data),
      changes,
      approvalsRequested,
    });
    const updated = await db.site.findUniqueOrThrow({
      where: { id: site.id },
      include: withEnvironments,
    });
    const [view] = await views([updated]);
    res.json({ site: view, approvalsRequested });
  });

  // Archive waits for a second Admin (SPEC §5 site.delete; Phase 1 uses archive, A91).
  router.post("/:id/archive", canManage, async (req, res) => {
    const site = await load(req, res);
    if (!site) return;
    if (site.archived) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    const { user } = sessionOf(req);
    const asked = await requestApproval(
      db,
      {
        action: "site.archive",
        payload: { siteId: site.id, kind: "PRODUCTION", name: site.name },
        requestedById: user.id,
        ip: clientIpOf(req),
        requesterRole: user.role,
      },
      now(),
    );
    if (!asked.ok) {
      res.status(409).json({ error: "already_pending" });
      return;
    }
    const selfApproved = await selfApproveIfAllowed(
      { db, now, notifier: deps.notifier },
      asked.id,
      user,
      clientIpOf(req),
    );
    await record(req, "site.archive", site.id, selfApproved ? "success" : "pending", {
      requestId: asked.id,
      selfApproved,
    });
    res.json({ ok: true, approvalId: asked.id, selfApproved });
  });

  router.post("/:id/restore", canManage, async (req, res) => {
    const site = await load(req, res);
    if (!site) return;
    if (!site.archived) {
      res.status(409).json({ error: "out_of_date" });
      return;
    }
    await db.site.update({ where: { id: site.id }, data: { archived: false } });
    await record(req, "site.restore", site.id, "success");
    res.json({ ok: true });
  });

  async function environment(req: Request, res: Response) {
    const site = await load(req, res);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    const env =
      site && kind.success ? site.environments.find((e) => e.kind === kind.data) : undefined;
    if (site && !env) res.status(404).json({ error: "not_found" });
    return site && env ? { site, env } : null;
  }

  router.post("/:id/environments/:kind/test", canManage, async (req, res) => {
    const found = await environment(req, res);
    if (!found) return;
    const { site, env } = found;
    const target = {
      host: env.sshHost,
      port: env.sshPort,
      user: env.sshUser,
      wpPath: env.wpPath,
      credentialRef: env.credentialRef,
      hostKey: env.hostKey,
    };
    // WP Engine: also try the legacy /home/wpe-user/sites path (A107).
    const wpPathCandidates =
      site.host === "WPENGINE"
        ? [`/sites/${env.sshUser}`, `/home/wpe-user/sites/${env.sshUser}`].filter(
            (p) => p !== env.wpPath,
          )
        : undefined;
    const raw = await callRunner(res, () =>
      deps.runner.run({ type: "site.test", target, wpPathCandidates }, 60_000),
    );
    if (raw === null) return;
    const result = SiteTestResult.parse(raw);
    // Trust on first use: the first successful test pins the host key (agent decision A47).
    const hostKeyPinned = result.ok && env.hostKey === null && result.hostKey !== null;
    const pathUpdated =
      result.ok && result.wpPath != null && result.wpPath !== env.wpPath ? result.wpPath : null;
    const firstFailure = result.steps.find((step) => !step.ok)?.detail ?? null;
    await db.siteEnvironment.update({
      where: { id: env.id },
      data: {
        lastTestAt: now(),
        lastTestOk: result.ok,
        lastTestError: result.ok ? null : firstFailure,
        ...(result.ok
          ? {
              wpVersion: result.wpVersion,
              phpVersion: result.phpVersion,
              wpCliVersion: result.wpCliVersion,
            }
          : {}),
        ...(hostKeyPinned ? { hostKey: result.hostKey } : {}),
        ...(pathUpdated ? { wpPath: pathUpdated } : {}),
      },
    });
    await record(req, "site.test", site.id, result.ok ? "success" : "failure", {
      kind: env.kind,
      steps: result.steps.map((s) => `${s.name}:${s.ok ? "ok" : "failed"}`),
      ...(hostKeyPinned ? { hostKeyPinned: result.hostKey } : {}),
      ...(pathUpdated ? { wpPathUpdated: pathUpdated } : {}),
    });
    if (result.hostKeyMismatch) {
      await raiseAlert(
        db,
        deps.notifier,
        {
          kind: "HOST_KEY_MISMATCH",
          userId: sessionOf(req).user.id,
          ip: clientIpOf(req) ?? "unknown",
          userAgent: "",
        },
        now(),
      );
    }
    res.json({ ...result, hostKeyPinned });
  });

  router.post("/:id/environments/:kind/host-key/reset", canManage, async (req, res) => {
    const found = await environment(req, res);
    if (!found) return;
    const { site, env } = found;
    if (!env.hostKey) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { user } = sessionOf(req);
    const requested = await requestApproval(
      db,
      {
        action: "site.hostkey.reset",
        payload: { siteId: site.id, kind: env.kind, hostKey: env.hostKey },
        requestedById: user.id,
        ip: clientIpOf(req),
        requesterRole: user.role,
      },
      now(),
      deps.notifier,
    );
    if (!requested.ok) {
      res.status(409).json({ error: requested.error });
      return;
    }
    const selfApproved = await selfApproveIfAllowed(
      { db, now, notifier: deps.notifier },
      requested.id,
      user,
      clientIpOf(req),
    );
    res.status(202).json({ ok: true, selfApproved });
  });

  return router;
}
