// Security page and site Security tab (Phase 2 step 2, A132).
import {
  RecordId,
  type Severity,
  SEVERITY_ORDER,
  type VulnFindingList,
  type VulnFindingView,
  type VulnSummary,
  worstSeverity,
} from "@ulixops/shared";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { activeSiteWhereForUser } from "../sites/access";
import { isSyncing, readFeedStatus, syncVulnerabilities, type VulnDeps } from "./service";

/** Resolved findings stay visible this long on a site's Security tab. */
const RESOLVED_DAYS = 90;
const MAX_FINDINGS = 2000;

const ListQuery = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
  siteId: RecordId.optional(),
});

const include = {
  vulnerability: true,
  environment: { select: { kind: true, site: { select: { id: true, name: true } } } },
} as const;
type FindingRow = Prisma.VulnerabilityFindingGetPayload<{ include: typeof include }>;

function view(row: FindingRow): VulnFindingView {
  const severity = (
    SEVERITY_ORDER.includes(row.vulnerability.severity as Severity)
      ? row.vulnerability.severity
      : "unknown"
  ) as Severity;
  return {
    id: row.id,
    siteId: row.environment.site.id,
    siteName: row.environment.site.name,
    environment: row.environment.kind,
    type: row.softwareType as VulnFindingView["type"],
    slug: row.slug,
    installedVersion: row.installedVersion,
    fixedIn: row.fixedIn,
    vulnerabilityId: row.vulnerabilityId,
    title: row.vulnerability.title,
    severity,
    cvssScore: row.vulnerability.cvssScore,
    cve: row.vulnerability.cve,
    reference: row.vulnerability.reference,
    firstSeenAt: row.firstSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/** Worst first, then site name, then software. */
function sortFindings(findings: VulnFindingView[]): VulnFindingView[] {
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.siteName.localeCompare(b.siteName) ||
      a.slug.localeCompare(b.slug),
  );
}

/** Open findings per environment id, for the sites list (sites/routes.ts). */
export async function vulnSummaries(
  db: Db,
  environmentIds: string[],
): Promise<Map<string, VulnSummary>> {
  const rows = environmentIds.length
    ? await db.vulnerabilityFinding.findMany({
        where: { environmentId: { in: environmentIds }, resolvedAt: null },
        select: { environmentId: true, vulnerability: { select: { severity: true } } },
      })
    : [];
  const levels = new Map<string, Severity[]>();
  for (const row of rows) {
    const list = levels.get(row.environmentId) ?? [];
    list.push(row.vulnerability.severity as Severity);
    levels.set(row.environmentId, list);
  }
  const out = new Map<string, VulnSummary>();
  for (const id of environmentIds) {
    const list = levels.get(id) ?? [];
    out.set(id, { open: list.length, worst: worstSeverity(list) });
  }
  return out;
}

export function vulnerabilitiesRouter(deps: VulnDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canSync = authorize("vulns.sync", deps);

  router.get("/", canView, async (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const since = new Date(now().getTime() - RESOLVED_DAYS * 86_400_000);
    const siteScope = {
      ...activeSiteWhereForUser(sessionOf(req).user),
      ...(query.data.siteId ? { id: query.data.siteId } : {}),
    };
    const rows = await db.vulnerabilityFinding.findMany({
      where: {
        resolvedAt: query.data.status === "open" ? null : { gte: since },
        environment: { site: siteScope },
      },
      include,
      take: MAX_FINDINGS,
      orderBy: { firstSeenAt: "desc" },
    });
    const body: VulnFindingList = {
      findings: sortFindings(rows.map(view)),
      feed: await readFeedStatus(db),
    };
    res.json(body);
  });

  router.post("/sync", canSync, (req, res) => {
    if (isSyncing()) {
      res.status(409).json({ error: "sync_running" });
      return;
    }
    const { user } = sessionOf(req);
    // The feed takes minutes; the page polls the status instead of holding the request.
    void syncVulnerabilities(deps, { userId: user.id, ip: clientIpOf(req) }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "vuln_sync_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    res.status(202).json({ started: true });
  });

  return router;
}

/** GET /sites/:id/vulnerabilities: open findings plus those resolved in the last 90 days. */
export function siteVulnerabilitiesRouter(deps: VulnDeps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);

  router.get("/:id/vulnerabilities", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const site = id.success
      ? await db.site.findUnique({ where: { id: id.data }, select: { id: true } })
      : null;
    if (!site) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const since = new Date(now().getTime() - RESOLVED_DAYS * 86_400_000);
    const rows = await db.vulnerabilityFinding.findMany({
      where: {
        environment: { siteId: site.id },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }],
      },
      include,
      take: MAX_FINDINGS,
    });
    const body: VulnFindingList = {
      findings: sortFindings(rows.map(view)),
      feed: await readFeedStatus(db),
    };
    res.json(body);
  });

  return router;
}
