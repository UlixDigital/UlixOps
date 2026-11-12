import { SiteReportView, isAdminRole } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmailReportForm } from "./email-form";

export const metadata: Metadata = { title: "Site report · UlixOps" };

function severityClass(s: string) {
  if (s === "critical") return "text-destructive font-medium";
  if (s === "warning") return "text-amber-700 dark:text-amber-400 font-medium";
  return "text-muted-foreground";
}

function statusBadge(status: "open" | "fixed" | "cleared") {
  if (status === "open")
    return "bg-destructive/10 text-destructive px-2 py-0.5 rounded-full text-xs";
  if (status === "fixed")
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full text-xs";
  return "bg-muted text-muted-foreground px-2 py-0.5 rounded-full text-xs";
}

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const res = await apiGet(`/reports/${id}`, SiteReportView, await apiAuth(), {
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    if (res.error === "not_found") notFound();
    return <Notice tone="error">This report couldn&apos;t be loaded.</Notice>;
  }
  const report = res.data;
  const summary = report.summary;
  const admin = isAdminRole(session.user.role);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/reports" className="hover:underline">
              Reports
            </Link>
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            {report.siteName}{" "}
            <span className="text-base font-normal text-muted-foreground">{report.label}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/sites/${report.siteId}`} className="hover:underline">
              {report.siteUrl}
            </Link>
            {" · "}
            Generated {formatUtc(report.generatedAt)}
            {report.emailedAt ? ` · Emailed ${formatUtc(report.emailedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {report.status === "READY" ? (
            <a
              href={`/api/reports/${report.id}/pdf`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Download PDF
            </a>
          ) : null}
        </div>
      </div>

      {report.status === "FAILED" ? (
        <Notice tone="error">{report.detail ?? "Report failed."}</Notice>
      ) : null}

      {summary ? (
        <>
          <section>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              At a glance
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: "Issues raised", value: String(summary.glance.raised) },
                { label: "Still open", value: String(summary.glance.open) },
                {
                  label: "Fixed / cleared",
                  value: String(summary.glance.fixed + summary.glance.cleared),
                },
                {
                  label: "Median time to fix",
                  value: summary.glance.medianFixLabel ?? "—",
                },
              ].map((t) => (
                <Card key={t.label} className="p-4">
                  <p className="text-xs text-muted-foreground">{t.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
                </Card>
              ))}
            </div>
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            <Card className="p-4">
              <h2 className="text-sm font-medium">Severity this month</h2>
              <div className="mt-3 grid gap-3">
                {(
                  [
                    ["Critical", summary.severity.critical, "fill-destructive"],
                    ["Warning", summary.severity.warning, "fill-amber-500"],
                    ["Info", summary.severity.info, "fill-primary"],
                  ] as const
                ).map(([label, n, fillClass]) => {
                  const max = Math.max(
                    1,
                    summary.severity.critical,
                    summary.severity.warning,
                    summary.severity.info,
                  );
                  const pct = Math.round((n / max) * 100);
                  return (
                    <div key={label}>
                      <div className="flex justify-between text-xs">
                        <span>{label}</span>
                        <span className="tabular-nums">{n}</span>
                      </div>
                      <svg
                        width="100%"
                        height="8"
                        className="mt-1 block"
                        role="img"
                        aria-label={`${label}: ${n}`}
                      >
                        <title>{`${label}: ${n}`}</title>
                        <rect width="100%" height="8" rx="4" className="fill-muted" />
                        {pct > 0 ? (
                          <rect width={`${pct}%`} height="8" rx="4" className={fillClass} />
                        ) : null}
                      </svg>
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card className="p-4">
              <h2 className="text-sm font-medium">Ops snapshot (production)</h2>
              <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                <li>
                  Uptime{" "}
                  <span className="font-medium text-foreground">
                    {summary.ops.uptimePercent == null ? "n/a" : `${summary.ops.uptimePercent}%`}
                  </span>{" "}
                  · {summary.ops.incidents} incident
                  {summary.ops.incidents === 1 ? "" : "s"} ({summary.ops.downtimeMinutes} min)
                </li>
                <li>
                  Malware scans:{" "}
                  <span className="font-medium text-foreground">{summary.ops.malwareScans}</span>
                  {summary.ops.malwareInfected
                    ? ` · ${summary.ops.malwareInfected} infected`
                    : " · clean"}
                </li>
                <li>
                  Vulnerabilities:{" "}
                  <span className="font-medium text-foreground">{summary.ops.vulnsOpen}</span> open
                  · {summary.ops.vulnsNew} new · {summary.ops.vulnsResolved} resolved
                </li>
                <li>
                  Integrity changed:{" "}
                  <span className="font-medium text-foreground">
                    {summary.ops.integrityChanged}
                  </span>{" "}
                  · PHP fatals: {summary.ops.phpFatals} · Visual: {summary.ops.visualChanged}{" "}
                  changed / {summary.ops.visualFailed} failed
                </li>
              </ul>
            </Card>
          </div>

          <Card className="overflow-hidden p-0">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-medium">Issues, actions &amp; time to fix</h2>
            </div>
            {summary.issues.length === 0 ? (
              <p className="px-4 py-8 text-sm text-muted-foreground">
                No actionable issues in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Issue</th>
                      <th className="px-4 py-2 font-medium">Severity</th>
                      <th className="px-4 py-2 font-medium">Action</th>
                      <th className="px-4 py-2 font-medium">Raised → fixed</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.issues.map((issue) => (
                      <tr key={issue.alertId} className="border-b last:border-0 align-top">
                        <td className="px-4 py-2 font-medium">{issue.title}</td>
                        <td className={cn("px-4 py-2 capitalize", severityClass(issue.severity))}>
                          {issue.severity}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{issue.action ?? "—"}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          <div>{formatUtc(issue.raisedAt)}</div>
                          <div>→ {issue.fixedAt ? formatUtc(issue.fixedAt) : "open"}</div>
                          <div className="text-xs">{issue.durationLabel}</div>
                        </td>
                        <td className="px-4 py-2">
                          <span className={statusBadge(issue.status)}>
                            {issue.status === "open"
                              ? "Open"
                              : issue.status === "fixed"
                                ? "Fixed"
                                : "Cleared"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-medium">Full details (production)</h2>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Malware scans</span> —{" "}
                {summary.ops.malwareScans} finished · {summary.ops.malwareInfected} infected.
              </p>
              <p>
                <span className="font-medium text-foreground">Vulnerabilities</span> —{" "}
                {summary.ops.vulnsNew} new, {summary.ops.vulnsResolved} resolved,{" "}
                {summary.ops.vulnsOpen} open now.
              </p>
              <p>
                <span className="font-medium text-foreground">File integrity</span> —{" "}
                {summary.ops.integrityChanged} changed check
                {summary.ops.integrityChanged === 1 ? "" : "s"}.
              </p>
              <p>
                <span className="font-medium text-foreground">SSL &amp; domains</span> — SSL expires{" "}
                {summary.ops.sslExpiresAt ? summary.ops.sslExpiresAt.slice(0, 10) : "—"} · Domain
                expires{" "}
                {summary.ops.domainExpiresAt ? summary.ops.domainExpiresAt.slice(0, 10) : "—"}.
              </p>
              <p>
                <span className="font-medium text-foreground">PHP errors</span> —{" "}
                {summary.ops.phpFatals} fatal alert{summary.ops.phpFatals === 1 ? "" : "s"} this
                month.
              </p>
              <p>
                <span className="font-medium text-foreground">Uptime</span> —{" "}
                {summary.ops.uptimePercent == null ? "n/a" : `${summary.ops.uptimePercent}%`} ·{" "}
                {summary.ops.incidents} incident{summary.ops.incidents === 1 ? "" : "s"} ·{" "}
                {summary.ops.downtimeMinutes} min downtime.
              </p>
              <p>
                <span className="font-medium text-foreground">Visual checks</span> —{" "}
                {summary.ops.visualChanged} changed · {summary.ops.visualFailed} failed.
              </p>
            </div>
          </Card>
        </>
      ) : null}

      {admin && report.status === "READY" ? <EmailReportForm reportId={report.id} /> : null}
    </div>
  );
}
