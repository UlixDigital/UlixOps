// Build one month of per-site report data (A165/A166): production monitoring issues only.
import {
  alertBelongsToSiteProduction,
  ALERT_RESOLUTION_LABELS,
  type AlertResolution,
  type AlertStatus,
  FIX_ACTION_LABELS,
  type FixAction,
  formatDurationMs,
  isReportIssueKind,
  monthLabelUtc,
  type ReportIssue,
  type ReportIssueStatus,
  type ReportSummary,
  uptimePercent,
} from "@ulixops/shared";
import { median } from "../alerts/metrics";
import type { Db } from "../db";

function issueStatus(status: AlertStatus, resolution: string | null): ReportIssueStatus {
  if (status === "OPEN" || status === "ACKNOWLEDGED") return "open";
  if (status === "AUTO_CLEARED") return "cleared";
  if (resolution === "FALSE_POSITIVE" || resolution === "NO_ACTION_NEEDED") return "cleared";
  return "fixed";
}

function actionLabel(
  status: AlertStatus,
  fixAction: string | null,
  resolution: string | null,
): string | null {
  if (fixAction && fixAction in FIX_ACTION_LABELS) {
    return FIX_ACTION_LABELS[fixAction as FixAction];
  }
  if (status === "AUTO_CLEARED") return "Cleared on its own";
  if (resolution && resolution in ALERT_RESOLUTION_LABELS) {
    return ALERT_RESOLUTION_LABELS[resolution as AlertResolution];
  }
  return null;
}

function vulnSeverity(raw: string): ReportIssue["severity"] {
  if (raw === "critical" || raw === "high") return "critical";
  if (raw === "medium") return "warning";
  return "info";
}

export async function aggregateSiteMonth(
  db: Db,
  siteId: string,
  periodStart: Date,
  periodEnd: Date,
  asOf: Date = new Date(),
): Promise<ReportSummary | null> {
  const site = await db.site.findFirst({
    where: { id: siteId, archived: false },
    include: {
      environments: {
        select: {
          id: true,
          kind: true,
          url: true,
          sslCertificate: true,
        },
      },
    },
  });
  if (!site) return null;

  const production = site.environments.find((e) => e.kind === "PRODUCTION") ?? null;
  const nonProductionEnvIds = site.environments
    .filter((e) => e.kind !== "PRODUCTION")
    .map((e) => e.id);

  // Single-site monitoring alerts only — no approvals, deploys, backups, or multi-site digests.
  const alerts = await db.alert.findMany({
    where: {
      siteIds: { equals: [siteId] },
      actionable: true,
      kind: {
        in: [
          "malware.found",
          "integrity.changed",
          "ssl.expiring",
          "ssl.invalid",
          "domain.expiring",
          "php.fatal",
          "uptime.down",
          "visual.changed",
          "visual.failed",
        ],
      },
      OR: [
        { firstRaisedAt: { gte: periodStart, lt: periodEnd } },
        { resolvedAt: { gte: periodStart, lt: periodEnd } },
        { closedAt: { gte: periodStart, lt: periodEnd } },
        {
          status: { in: ["OPEN", "ACKNOWLEDGED", "RESOLVED"] },
          firstRaisedAt: { lt: periodEnd },
        },
      ],
    },
  });

  const filtered = alerts.filter((a) =>
    alertBelongsToSiteProduction({
      siteId,
      siteIds: a.siteIds,
      scope: a.scope,
      kind: a.kind,
      productionEnvId: production?.id ?? null,
      nonProductionEnvIds,
    }),
  );

  const endCapMs = Math.min(asOf.getTime(), periodEnd.getTime());
  const issues: ReportIssue[] = [];

  for (const a of filtered) {
    if (!isReportIssueKind(a.kind)) continue;
    const status = issueStatus(a.status as AlertStatus, a.resolution);
    const fixedAt = a.resolvedAt ?? a.closedAt ?? a.verifiedAt;
    const ongoing = status === "open";
    const endMs = ongoing ? endCapMs : (fixedAt?.getTime() ?? endCapMs);
    const durationMs = Math.max(0, endMs - a.firstRaisedAt.getTime());
    issues.push({
      alertId: a.id,
      title: a.title.slice(0, 300),
      severity:
        a.severity === "critical" || a.severity === "warning" || a.severity === "info"
          ? a.severity
          : "info",
      action: actionLabel(a.status as AlertStatus, a.fixAction, a.resolution),
      raisedAt: a.firstRaisedAt.toISOString(),
      fixedAt: fixedAt && !ongoing ? fixedAt.toISOString() : null,
      durationMs,
      durationLabel: formatDurationMs(durationMs, { ongoing }),
      status,
    });
  }

  // Vulnerabilities from production findings (alert digests often span many sites).
  if (production) {
    const findings = await db.vulnerabilityFinding.findMany({
      where: {
        environmentId: production.id,
        OR: [
          { firstSeenAt: { gte: periodStart, lt: periodEnd } },
          { resolvedAt: { gte: periodStart, lt: periodEnd } },
          // Still open and seen again during the month (not every historic open vuln).
          { resolvedAt: null, lastSeenAt: { gte: periodStart, lt: periodEnd } },
        ],
      },
      include: { vulnerability: { select: { title: true, severity: true } } },
      orderBy: { firstSeenAt: "desc" },
      take: 100,
    });
    for (const f of findings) {
      const resolvedAt = f.resolvedAt;
      const ongoing = resolvedAt == null;
      const endMs = resolvedAt ? resolvedAt.getTime() : endCapMs;
      const durationMs = Math.max(0, endMs - f.firstSeenAt.getTime());
      const fixHint = f.fixedIn ? `Update to ${f.fixedIn}` : null;
      issues.push({
        alertId: f.id,
        title: `Vulnerability: ${f.slug} ${f.installedVersion} — ${f.vulnerability.title}`.slice(
          0,
          300,
        ),
        severity: vulnSeverity(f.vulnerability.severity),
        action: ongoing ? fixHint : (fixHint ?? "Updated / no longer affected"),
        raisedAt: f.firstSeenAt.toISOString(),
        fixedAt: resolvedAt ? resolvedAt.toISOString() : null,
        durationMs,
        durationLabel: formatDurationMs(durationMs, { ongoing }),
        status: ongoing ? "open" : "fixed",
      });
    }
  }

  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => {
    const ra = severityRank[a.severity];
    const rb = severityRank[b.severity];
    if (ra !== rb) return ra - rb;
    return new Date(b.raisedAt).getTime() - new Date(a.raisedAt).getTime();
  });
  const capped = issues.slice(0, 200);

  const closedFixMs = capped
    .filter((i) => i.status === "fixed" || i.status === "cleared")
    .map((i) => i.durationMs);
  const medianRaw = median(closedFixMs);
  const medianFixMs = medianRaw == null ? null : Math.round(medianRaw);

  const severity = {
    critical: capped.filter((i) => i.severity === "critical").length,
    warning: capped.filter((i) => i.severity === "warning").length,
    info: capped.filter((i) => i.severity === "info").length,
  };

  let ops = emptyOps();
  if (production) {
    const env = production;
    const [
      vulnsOpen,
      vulnsNew,
      vulnsResolved,
      malwareInfected,
      malwareScans,
      integrityChanged,
      phpFatals,
      visualChanged,
      visualFailed,
      uptimeChecks,
      incidents,
    ] = await Promise.all([
      db.vulnerabilityFinding.count({
        where: { environmentId: env.id, resolvedAt: null },
      }),
      db.vulnerabilityFinding.count({
        where: {
          environmentId: env.id,
          firstSeenAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.vulnerabilityFinding.count({
        where: {
          environmentId: env.id,
          resolvedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.malwareScan.count({
        where: {
          environmentId: env.id,
          status: "INFECTED",
          finishedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.malwareScan.count({
        where: {
          environmentId: env.id,
          finishedAt: { gte: periodStart, lt: periodEnd },
          status: { in: ["CLEAN", "INFECTED", "FAILED"] },
        },
      }),
      db.integrityCheck.count({
        where: {
          environmentId: env.id,
          status: "CHANGED",
          finishedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.alert.count({
        where: {
          kind: "php.fatal",
          siteIds: { equals: [siteId] },
          scope: env.id,
          firstRaisedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.alert.count({
        where: {
          kind: "visual.changed",
          siteIds: { equals: [siteId] },
          scope: env.id,
          firstRaisedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.alert.count({
        where: {
          kind: "visual.failed",
          siteIds: { equals: [siteId] },
          scope: env.id,
          firstRaisedAt: { gte: periodStart, lt: periodEnd },
        },
      }),
      db.uptimeCheck.findMany({
        where: {
          environmentId: env.id,
          checkedAt: { gte: periodStart, lt: periodEnd },
          excluded: false,
        },
        select: { ok: true },
      }),
      db.uptimeIncident.findMany({
        where: {
          environmentId: env.id,
          startedAt: { lt: periodEnd },
          OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }],
        },
      }),
    ]);

    let downtimeMinutes = 0;
    for (const inc of incidents) {
      const from = Math.max(inc.startedAt.getTime(), periodStart.getTime());
      const to = Math.min((inc.endedAt ?? periodEnd).getTime(), periodEnd.getTime());
      if (to > from) downtimeMinutes += Math.round((to - from) / 60_000);
    }

    const failedChecks = uptimeChecks.filter((c) => !c.ok).length;

    let domainExpiresAt: string | null = null;
    try {
      const host = new URL(env.url).hostname.toLowerCase();
      const regs = await db.domainRegistration.findMany();
      const reg = regs.find(
        (d) => host === d.domain.toLowerCase() || host.endsWith(`.${d.domain.toLowerCase()}`),
      );
      const expires = reg?.expiresAt ?? reg?.manualExpiresAt;
      if (expires) domainExpiresAt = expires.toISOString();
    } catch {
      /* invalid site URL */
    }

    ops = {
      malwareScans,
      malwareInfected,
      vulnsOpen,
      vulnsNew,
      vulnsResolved,
      integrityChanged,
      phpFatals,
      visualChanged,
      visualFailed,
      uptimePercent:
        uptimeChecks.length === 0 ? null : uptimePercent(uptimeChecks.length, failedChecks),
      incidents: incidents.length,
      downtimeMinutes,
      sslExpiresAt: env.sslCertificate?.validTo?.toISOString() ?? null,
      domainExpiresAt,
    };
  }

  return {
    siteId: site.id,
    siteName: site.name,
    siteUrl: site.url,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    label: monthLabelUtc(periodStart),
    glance: {
      raised: capped.length,
      open: capped.filter((i) => i.status === "open").length,
      fixed: capped.filter((i) => i.status === "fixed").length,
      cleared: capped.filter((i) => i.status === "cleared").length,
      medianFixMs,
      medianFixLabel: medianFixMs == null ? null : formatDurationMs(medianFixMs),
    },
    severity,
    issues: capped,
    ops,
  };
}

function emptyOps(): ReportSummary["ops"] {
  return {
    malwareScans: 0,
    malwareInfected: 0,
    vulnsOpen: 0,
    vulnsNew: 0,
    vulnsResolved: 0,
    integrityChanged: 0,
    phpFatals: 0,
    visualChanged: 0,
    visualFailed: 0,
    uptimePercent: null,
    incidents: 0,
    downtimeMinutes: 0,
    sslExpiresAt: null,
    domainExpiresAt: null,
  };
}
