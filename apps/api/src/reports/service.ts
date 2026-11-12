// Monthly site reports (P4-4, A165): generate, list, PDF, email.
import {
  monthLabelUtc,
  monthWindowUtc,
  previousMonthWindowUtc,
  ReportSummary,
  type ReportsOverview,
  type ReportSiteRow,
  type SiteReportView,
  type GenerateReportRequest,
} from "@ulixops/shared";
import type { SessionInfo } from "@ulixops/shared";
import { Prisma } from "../generated/prisma/client";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Mailer } from "../notifications/channels";
import { adminUserIds } from "../notifications/dispatch";
import type { SecurityNotifier } from "../notify";
import { activeSiteWhereForUser, canAccessSite } from "../sites/access";
import { aggregateSiteMonth } from "./aggregate";
import { buildReportPdf } from "./pdf";

export interface ReportDeps {
  db: Db;
  now: () => Date;
  notifier?: SecurityNotifier;
  mailer?: Mailer | null;
}

function toView(row: {
  id: string;
  siteId: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  summary: unknown;
  detail: string | null;
  generatedAt: Date;
  emailedAt: Date | null;
  emailedTo: string[];
  site?: { name: string; url: string } | null;
}): SiteReportView {
  const parsed = ReportSummary.safeParse(row.summary);
  const siteName = parsed.success ? parsed.data.siteName : (row.site?.name ?? "Site");
  const siteUrl = parsed.success ? parsed.data.siteUrl : (row.site?.url ?? "");
  return {
    id: row.id,
    siteId: row.siteId,
    siteName,
    siteUrl,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    label: monthLabelUtc(row.periodStart),
    status: row.status === "FAILED" ? "FAILED" : "READY",
    summary: parsed.success ? parsed.data : null,
    detail: row.detail,
    generatedAt: row.generatedAt.toISOString(),
    emailedAt: row.emailedAt?.toISOString() ?? null,
    emailedTo: row.emailedTo,
  };
}

export async function listSites(
  db: Db,
  user?: SessionInfo["user"],
): Promise<ReportSiteRow[]> {
  const sites = await db.site.findMany({
    where: user ? activeSiteWhereForUser(user) : { archived: false },
    select: { id: true, name: true, url: true, tags: true },
    orderBy: { name: "asc" },
  });
  const ids = sites.map((s) => s.id);
  const lastReports = await db.siteReport.findMany({
    where: { siteId: { in: ids }, status: "READY" },
    orderBy: { periodStart: "desc" },
    include: { site: { select: { name: true, url: true } } },
  });
  const lastBySite = new Map<string, (typeof lastReports)[0]>();
  for (const r of lastReports) {
    if (!lastBySite.has(r.siteId)) lastBySite.set(r.siteId, r);
  }
  return sites.map((s) => {
    const last = lastBySite.get(s.id);
    return {
      siteId: s.id,
      siteName: s.name,
      siteUrl: s.url,
      tags: s.tags.slice(0, 20),
      lastReport: last ? toView(last) : null,
    };
  });
}

export async function reportsOverview(
  deps: ReportDeps,
  user: SessionInfo["user"],
): Promise<ReportsOverview> {
  const prev = previousMonthWindowUtc(deps.now());
  const siteScope = activeSiteWhereForUser(user);
  const [sites, recent] = await Promise.all([
    listSites(deps.db, user),
    deps.db.siteReport.findMany({
      where: { site: siteScope },
      orderBy: { generatedAt: "desc" },
      take: 50,
      include: { site: { select: { name: true, url: true } } },
    }),
  ]);
  return {
    sites,
    recent: recent.map(toView),
    previousMonth: {
      start: prev.start.toISOString(),
      end: prev.end.toISOString(),
      label: monthLabelUtc(prev.start),
    },
  };
}

export async function generateReport(
  deps: ReportDeps,
  input: GenerateReportRequest,
  actor: { userId: string | null; ip?: string | null },
): Promise<SiteReportView> {
  const window = input.periodStart
    ? monthWindowUtc(new Date(input.periodStart))
    : previousMonthWindowUtc(deps.now());

  const summary = await aggregateSiteMonth(
    deps.db,
    input.siteId,
    window.start,
    window.end,
    deps.now(),
  );

  if (!summary) {
    const failed = await deps.db.siteReport.upsert({
      where: {
        siteId_periodStart: { siteId: input.siteId, periodStart: window.start },
      },
      create: {
        siteId: input.siteId,
        periodStart: window.start,
        periodEnd: window.end,
        status: "FAILED",
        detail: "Site not found or archived",
        generatedAt: deps.now(),
        generatedById: actor.userId,
      },
      update: {
        status: "FAILED",
        detail: "Site not found or archived",
        summary: Prisma.DbNull,
        generatedAt: deps.now(),
        generatedById: actor.userId,
      },
      include: { site: { select: { name: true, url: true } } },
    });
    await audit(
      deps.db,
      {
        userId: actor.userId,
        action: "report.generate",
        result: "failure",
        ip: actor.ip ?? null,
        siteIds: [input.siteId],
        meta: { periodStart: window.start.toISOString() },
      },
      deps.now(),
    );
    return toView(failed);
  }

  const row = await deps.db.siteReport.upsert({
    where: {
      siteId_periodStart: { siteId: input.siteId, periodStart: window.start },
    },
    create: {
      siteId: input.siteId,
      periodStart: window.start,
      periodEnd: window.end,
      status: "READY",
      summary,
      detail: null,
      generatedAt: deps.now(),
      generatedById: actor.userId,
      emailedAt: null,
      emailedTo: [],
    },
    update: {
      periodEnd: window.end,
      status: "READY",
      summary,
      detail: null,
      generatedAt: deps.now(),
      generatedById: actor.userId,
    },
    include: { site: { select: { name: true, url: true } } },
  });

  await audit(
    deps.db,
    {
      userId: actor.userId,
      action: "report.generate",
      result: "success",
      ip: actor.ip ?? null,
      siteIds: [input.siteId],
      meta: {
        reportId: row.id,
        periodStart: window.start.toISOString(),
        issues: summary.glance.raised,
      },
    },
    deps.now(),
  );

  if (deps.notifier?.notify) {
    await deps.notifier.notify({
      kind: "report.ready",
      title: `Monthly report ready: ${summary.siteName} (${summary.label})`,
      body: `${summary.glance.raised} issue(s) · ${summary.glance.open} open · median fix ${summary.glance.medianFixLabel ?? "n/a"}`,
      severity: "info",
      siteIds: [input.siteId],
      meta: { reportId: row.id, siteId: input.siteId },
    });
  }

  return toView(row);
}

export async function getReport(
  deps: ReportDeps,
  id: string,
  user: SessionInfo["user"],
): Promise<SiteReportView | null> {
  const row = await deps.db.siteReport.findUnique({
    where: { id },
    include: { site: { select: { name: true, url: true, tags: true, archived: true } } },
  });
  if (!row || !canAccessSite(user, row.site)) return null;
  return toView(row);
}

export async function reportPdfBuffer(
  deps: ReportDeps,
  id: string,
  user: SessionInfo["user"],
): Promise<{ filename: string; buffer: Buffer } | null> {
  const row = await deps.db.siteReport.findUnique({
    where: { id },
    include: { site: { select: { tags: true, archived: true } } },
  });
  if (!row || row.status !== "READY" || !canAccessSite(user, row.site)) return null;
  const summary = ReportSummary.safeParse(row.summary);
  if (!summary.success) return null;
  const buffer = await buildReportPdf(summary.data, {
    generatedAt: row.generatedAt.toISOString(),
  });
  const safeName = summary.data.siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const filename = `ulixops-${safeName || summary.data.siteId}-${monthLabelUtc(row.periodStart).replace(/\s+/g, "-").toLowerCase()}.pdf`;
  return { filename, buffer };
}

export async function emailReport(
  deps: ReportDeps,
  id: string,
  extraTo: string[],
  actor: { userId: string | null; ip?: string | null },
): Promise<{ ok: true; to: string[] } | { ok: false; error: string }> {
  if (!deps.mailer) return { ok: false, error: "smtp_not_configured" };
  // Email is Admin-only; use a staff-shaped user so tag scope does not apply.
  const pdf = await reportPdfBuffer(deps, id, {
    id: actor.userId ?? "system",
    email: "",
    name: null,
    role: "ADMIN",
    viewTag: null,
  });
  if (!pdf) return { ok: false, error: "not_ready" };
  const row = await deps.db.siteReport.findUniqueOrThrow({
    where: { id },
    include: { site: { select: { name: true } } },
  });
  const adminIds = await adminUserIds(deps.db);
  const admins = await deps.db.user.findMany({
    where: { id: { in: adminIds }, active: true },
    select: { email: true },
  });
  const to = [...new Set([...admins.map((a) => a.email), ...extraTo])].slice(0, 20);
  if (to.length === 0) return { ok: false, error: "no_recipients" };

  const label = monthLabelUtc(row.periodStart);
  const siteName = row.site.name;
  try {
    await deps.mailer.send({
      to,
      subject: `UlixOps monthly report — ${siteName} — ${label}`,
      text: `Attached is the UlixOps monthly report for ${siteName} (${label}).\n\nOpen UlixOps → Reports to view it in the hub.`,
      attachments: [
        { filename: pdf.filename, content: pdf.buffer, contentType: "application/pdf" },
      ],
    });
  } catch {
    await audit(
      deps.db,
      {
        userId: actor.userId,
        action: "report.email",
        result: "failure",
        ip: actor.ip ?? null,
        siteIds: [row.siteId],
        meta: { reportId: id },
      },
      deps.now(),
    );
    return { ok: false, error: "send_failed" };
  }

  await deps.db.siteReport.update({
    where: { id },
    data: { emailedAt: deps.now(), emailedTo: to },
  });
  await audit(
    deps.db,
    {
      userId: actor.userId,
      action: "report.email",
      result: "success",
      ip: actor.ip ?? null,
      siteIds: [row.siteId],
      meta: { reportId: id, toCount: to.length },
    },
    deps.now(),
  );
  return { ok: true, to };
}

/** On the 1st of each month (UTC), generate previous-month reports for every active site. */
export async function runScheduledMonthlyReports(deps: ReportDeps): Promise<number> {
  const now = deps.now();
  if (now.getUTCDate() !== 1) return 0;
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const already = await deps.db.siteReport.count({
    where: { generatedById: null, generatedAt: { gte: startOfDay } },
  });
  if (already > 0) return 0;

  const sites = await listSites(deps.db);
  const periodStart = previousMonthWindowUtc(now).start;
  let n = 0;
  for (const s of sites) {
    const view = await generateReport(deps, { siteId: s.siteId }, { userId: null });
    n++;
    if (view.status === "READY" && deps.mailer) {
      const latest = await deps.db.siteReport.findUnique({
        where: { siteId_periodStart: { siteId: s.siteId, periodStart } },
      });
      if (latest) await emailReport(deps, latest.id, [], { userId: null });
    }
  }
  return n;
}
