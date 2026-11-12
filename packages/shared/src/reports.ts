// Monthly site reports (Phase 4 P4-4, A164 → A165/A166). One PDF per website: at-a-glance,
// issue/action/time-to-fix, then ops details. Built from Alert follow-up + hub ops data.
import { z } from "zod";
import { type NotificationEvent, NotificationSeverity } from "./notifications";

/**
 * Alert kinds that appear as report issues (A166). Approvals, deploys, backups, restores,
 * and hub-wide blasts are excluded. Production-only filtering is applied in the API.
 */
export const REPORT_ISSUE_KINDS = [
  "malware.found",
  "vulnerability.found",
  "integrity.changed",
  "ssl.expiring",
  "ssl.invalid",
  "domain.expiring",
  "php.fatal",
  "uptime.down",
  "visual.changed",
  "visual.failed",
] as const satisfies readonly NotificationEvent[];

export type ReportIssueKind = (typeof REPORT_ISSUE_KINDS)[number];

export function isReportIssueKind(kind: string): kind is ReportIssueKind {
  return (REPORT_ISSUE_KINDS as readonly string[]).includes(kind);
}

/**
 * Keep alerts that belong only to this site (not multi-site digests) and are not scoped to
 * a non-production environment of this site.
 */
export function alertBelongsToSiteProduction(input: {
  siteId: string;
  siteIds: string[];
  scope: string | null;
  kind: string;
  productionEnvId: string | null;
  nonProductionEnvIds: readonly string[];
}): boolean {
  if (!isReportIssueKind(input.kind)) return false;
  if (input.siteIds.length !== 1 || input.siteIds[0] !== input.siteId) return false;
  if (input.scope && input.nonProductionEnvIds.includes(input.scope)) return false;
  // Env-scoped kinds must target production when we know the production env id.
  const envScoped = !(input.kind === "domain.expiring" || input.kind === "vulnerability.found");
  if (envScoped && input.productionEnvId && input.scope && input.scope !== input.productionEnvId) {
    return false;
  }
  return true;
}

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

export const ReportStatus = z.enum(["READY", "FAILED"]);
export type ReportStatus = z.infer<typeof ReportStatus>;

export const ReportIssueStatus = z.enum(["open", "fixed", "cleared"]);
export type ReportIssueStatus = z.infer<typeof ReportIssueStatus>;

/** UTC calendar month containing `at` → [start, end) as ISO dates (end exclusive). */
export function monthWindowUtc(at: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Previous full UTC calendar month. */
export function previousMonthWindowUtc(at: Date = new Date()): { start: Date; end: Date } {
  const thisMonth = monthWindowUtc(at);
  const start = new Date(
    Date.UTC(thisMonth.start.getUTCFullYear(), thisMonth.start.getUTCMonth() - 1, 1),
  );
  return { start, end: thisMonth.start };
}

/** "October 2026" from a period start. */
export function monthLabelUtc(start: Date): string {
  return start.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Compact duration for report tables: "18m", "2h 28m", "3d 4h", "3d so far". */
export function formatDurationMs(ms: number, opts?: { ongoing?: boolean }): string {
  const ongoing = opts?.ongoing === true;
  const abs = Math.max(0, Math.round(ms));
  if (abs < 60_000) {
    const s = Math.max(1, Math.round(abs / 1000));
    return ongoing ? `${s}s so far` : `${s}s`;
  }
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return ongoing ? `${m}m so far` : `${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    const base = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return ongoing ? `${base} so far` : base;
  }
  const d = Math.floor(abs / 86_400_000);
  const h = Math.round((abs % 86_400_000) / 3_600_000);
  const base = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return ongoing ? `${base} so far` : base;
}

export const ReportIssue = z.object({
  alertId: id,
  title: z.string().max(300),
  severity: NotificationSeverity,
  /** Human-readable action taken, or null when still open / none recorded. */
  action: z.string().max(300).nullable(),
  raisedAt: iso,
  fixedAt: iso.nullable(),
  durationMs: z.number().int().nonnegative(),
  durationLabel: z.string().max(40),
  status: ReportIssueStatus,
});
export type ReportIssue = z.infer<typeof ReportIssue>;

/** Production-only ops snapshot for the report (A166). */
export const ReportOps = z.object({
  malwareScans: z.number().int().nonnegative(),
  malwareInfected: z.number().int().nonnegative(),
  vulnsOpen: z.number().int().nonnegative(),
  vulnsNew: z.number().int().nonnegative(),
  vulnsResolved: z.number().int().nonnegative(),
  integrityChanged: z.number().int().nonnegative(),
  phpFatals: z.number().int().nonnegative(),
  visualChanged: z.number().int().nonnegative(),
  visualFailed: z.number().int().nonnegative(),
  uptimePercent: z.number().min(0).max(100).nullable(),
  incidents: z.number().int().nonnegative(),
  downtimeMinutes: z.number().int().nonnegative(),
  sslExpiresAt: iso.nullable(),
  domainExpiresAt: iso.nullable(),
});
export type ReportOps = z.infer<typeof ReportOps>;

export const ReportSummary = z.object({
  siteId: id,
  siteName: z.string().max(200),
  siteUrl: z.string().max(500),
  periodStart: iso,
  periodEnd: iso,
  label: z.string().max(40),
  glance: z.object({
    raised: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    fixed: z.number().int().nonnegative(),
    cleared: z.number().int().nonnegative(),
    medianFixMs: z.number().int().nonnegative().nullable(),
    medianFixLabel: z.string().max(40).nullable(),
  }),
  severity: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  issues: z.array(ReportIssue).max(200),
  ops: ReportOps,
});
export type ReportSummary = z.infer<typeof ReportSummary>;

export const SiteReportView = z.object({
  id: id,
  siteId: id,
  siteName: z.string().max(200),
  siteUrl: z.string().max(500),
  periodStart: iso,
  periodEnd: iso,
  label: z.string().max(40),
  status: ReportStatus,
  summary: ReportSummary.nullable(),
  detail: z.string().max(500).nullable(),
  generatedAt: iso,
  emailedAt: iso.nullable(),
  emailedTo: z.array(z.string().email()).max(20),
});
export type SiteReportView = z.infer<typeof SiteReportView>;

/** @deprecated Prefer SiteReportView (A165). */
export const ClientReportView = SiteReportView;
export type ClientReportView = SiteReportView;

export const ReportSiteRow = z.object({
  siteId: id,
  siteName: z.string().max(200),
  siteUrl: z.string().max(500),
  tags: z.array(z.string().max(40)).max(20),
  lastReport: SiteReportView.nullable(),
});
export type ReportSiteRow = z.infer<typeof ReportSiteRow>;

export const ReportsOverview = z.object({
  sites: z.array(ReportSiteRow).max(200),
  recent: z.array(SiteReportView).max(50),
  previousMonth: z.object({ start: iso, end: iso, label: z.string() }),
});
export type ReportsOverview = z.infer<typeof ReportsOverview>;

export const GenerateReportRequest = z.object({
  siteId: id,
  /** Period start (1st of month UTC). Defaults to previous month. */
  periodStart: z.iso.datetime().optional(),
});
export type GenerateReportRequest = z.infer<typeof GenerateReportRequest>;

export const EmailReportRequest = z.object({
  /** Extra addresses; Admins are always included when SMTP is on. */
  to: z.array(z.string().trim().email().max(200)).max(10).default([]),
});
export type EmailReportRequest = z.infer<typeof EmailReportRequest>;
