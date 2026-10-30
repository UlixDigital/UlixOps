// On-demand site health checks (Build Order step 9, spec §6.6).
import { randomUUID } from "node:crypto";
import {
  buildHealthUrls,
  EnvKind,
  type HealthCheckResponse,
  healthFetchOrigin,
  HealthJobResult,
  RecordId,
  SITE_JOB_STALE_MS,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import type { z } from "zod";
import { raiseAlert } from "../alerts";
import { audit } from "../audit";
import type { Db } from "../db";
import { Prisma, type Site, type SiteEnvironment, type SiteJob } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { readHealthSettings } from "./settings";

const HEALTH_TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 20_000;

export interface HealthDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

export function healthSiteRouter(deps: HealthDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canCheck = authorize("sites.refresh", deps);

  async function emails(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    const users = wanted.length
      ? await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } })
      : [];
    return new Map(users.map((u) => [u.id, u]));
  }

  async function load(
    req: Request,
    res: Response,
  ): Promise<{ site: Site; env: SiteEnvironment } | null> {
    const id = RecordId.safeParse(req.params.id);
    const kind = EnvKind.safeParse(String(req.params.kind ?? "").toUpperCase());
    const site =
      id.success && kind.success
        ? await db.site.findUnique({
            where: { id: id.data },
            include: { environments: { where: { kind: kind.data } } },
          })
        : null;
    const env = site?.environments[0];
    if (!site || !env) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return { site, env };
  }

  async function claim(environmentId: string): Promise<string | null> {
    const token = randomUUID();
    const at = now();
    try {
      await db.siteEnvironmentLock.create({ data: { environmentId, token, lockedAt: at } });
      return token;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
        throw error;
    }
    const taken = await db.siteEnvironmentLock.updateMany({
      where: { environmentId, lockedAt: { lt: new Date(at.getTime() - SITE_JOB_STALE_MS) } },
      data: { token, lockedAt: at },
    });
    return taken.count === 1 ? token : null;
  }

  const release = (environmentId: string, token: string) =>
    db.siteEnvironmentLock.deleteMany({ where: { environmentId, token } });

  const pinned = (env: SiteEnvironment): env is SiteEnvironment & { hostKey: string } =>
    env.hostKey !== null;

  const targetOf = (env: SiteEnvironment & { hostKey: string }) => ({
    host: env.sshHost,
    port: env.sshPort,
    user: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
  });

  const cap = (text: string) =>
    text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}… (truncated)` : text;

  function jobView(
    job: SiteJob & { environment: { kind: EnvKind } },
    users: Map<string, { id: string; email: string }>,
  ) {
    return {
      id: job.id,
      kind: job.environment.kind,
      action: job.action,
      summary: "Health check",
      status: job.status,
      interrupted:
        job.status === "RUNNING" && now().getTime() - job.startedAt.getTime() > SITE_JOB_STALE_MS,
      exitCode: job.exitCode,
      output: job.output,
      requestedBy: job.requestedById ? (users.get(job.requestedById) ?? null) : null,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      durationMs: job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : null,
    };
  }

  router.post("/:id/environments/:kind/health", canCheck, async (req, res) => {
    const found = await load(req, res);
    if (!found) return;
    const { site, env } = found;
    if (site.archived) {
      res.status(409).json({ error: "site_archived" });
      return;
    }
    if (!pinned(env)) {
      res.status(409).json({ error: "connection_untested" });
      return;
    }

    const settings = await readHealthSettings(db);
    let urls: string[];
    let fetchOrigin: string;
    try {
      // Loopback site URLs (local test-wp) are rewritten to the SSH host for the runner (A80).
      fetchOrigin = healthFetchOrigin(env.url, env.sshHost);
      urls = buildHealthUrls(fetchOrigin, settings.extraPaths);
    } catch {
      res.status(422).json({ error: "bad_request" });
      return;
    }

    const token = await claim(env.id);
    if (!token) {
      res.status(409).json({ error: "site_busy" });
      return;
    }

    const userId = sessionOf(req).user.id;
    const job = await db.siteJob.create({
      data: {
        siteId: site.id,
        environmentId: env.id,
        action: "health.check",
        params: {
          urls,
          thresholdMs: settings.thresholdMs,
          checkErrorLog: settings.checkErrorLog,
        },
        requestedById: userId,
        startedAt: now(),
      },
    });

    let outcome: { ok: boolean; exitCode: number | null; output: string; error?: string };
    let hostKeyMismatch = false;
    let health: z.infer<typeof HealthCheckResponse>["health"] = null;

    try {
      const raw = await deps.runner.run(
        {
          type: "site.health",
          target: targetOf(env),
          urls,
          origin: fetchOrigin,
          thresholdMs: settings.thresholdMs,
          checkErrorLog: settings.checkErrorLog,
        },
        HEALTH_TIMEOUT_MS,
      );
      const result = HealthJobResult.parse(raw);
      if (result.hostKeyMismatch) {
        hostKeyMismatch = true;
        outcome = {
          ok: false,
          exitCode: null,
          output:
            "Refused: the server's SSH host key no longer matches the pinned one, so nothing ran. Admins were alerted.",
          error: "host_key_mismatch",
        };
      } else {
        const urlFailures = result.urls.filter((u) => !u.ok).length;
        const lines = [
          result.summary,
          ...result.urls.map(
            (u) =>
              `${u.ok ? "OK" : "FAIL"} ${u.role} ${u.url} → ${u.status ?? "—"} (${u.durationMs} ms) ${u.detail}`,
          ),
          `error log: ${result.errorLog.detail}`,
        ];
        await db.siteEnvironment.update({
          where: { id: env.id },
          data: {
            lastHealthAt: now(),
            lastHealthOk: result.ok,
            lastHealthSummary: result.summary.slice(0, 500),
          },
        });
        health = {
          ok: result.ok,
          checkedAt: now().toISOString(),
          summary: result.summary,
          durationMs: result.durationMs,
          urlFailures,
          errorLogOk: result.errorLog.skipped ? null : result.errorLog.ok,
        };
        // The job succeeded when the runner answered; site health is in `health.ok` (A79).
        outcome = {
          ok: true,
          exitCode: result.ok ? 0 : 1,
          output: lines.join("\n"),
        };
      }
    } catch (error) {
      if (error instanceof RunnerUnavailableError) {
        outcome = {
          ok: false,
          exitCode: null,
          output: "The runner didn't answer in time. The health check may still be running.",
          error: "runner_unavailable",
        };
      } else if (error instanceof RunnerJobFailedError) {
        outcome = { ok: false, exitCode: null, output: error.message, error: "runner_failed" };
      } else {
        await db.siteJob.update({
          where: { id: job.id },
          data: { status: "FAILED", finishedAt: now(), output: "Internal error" },
        });
        await release(env.id, token);
        throw error;
      }
    }

    try {
      const finished = await db.siteJob.update({
        where: { id: job.id },
        data: {
          status: outcome.ok ? "SUCCEEDED" : "FAILED",
          exitCode: outcome.exitCode,
          output: cap(outcome.output),
          finishedAt: now(),
        },
        include: { environment: { select: { kind: true } } },
      });
      await audit(
        db,
        {
          userId,
          action: "site.health.check",
          result: outcome.ok ? "success" : "failure",
          ip: clientIpOf(req),
          siteIds: [site.id],
          meta: {
            kind: env.kind,
            jobId: job.id,
            ...(outcome.error ? { error: outcome.error } : {}),
          },
        },
        now(),
      );
      if (hostKeyMismatch) {
        await raiseAlert(
          db,
          deps.notifier,
          { kind: "HOST_KEY_MISMATCH", userId, ip: clientIpOf(req) ?? "unknown", userAgent: "" },
          now(),
        );
      }
      const body: z.infer<typeof HealthCheckResponse> = {
        job: jobView(finished, await emails([userId])),
        hostKeyMismatch,
        health,
      };
      res.json(body);
    } finally {
      await release(env.id, token);
    }
  });

  return router;
}
