// Reports (P4-4, A165): monthly per-site PDF — issues, actions, time to fix, then ops.
import { isAdminRole, ReportsOverview } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { GenerateReportButton } from "./generate-button";

export const metadata: Metadata = { title: "Reports · UlixOps" };

export default async function ReportsPage() {
  const session = await requireSession();
  const res = await apiGet("/reports/overview", ReportsOverview, await apiAuth(), {
    timeoutMs: 20_000,
  });
  const admin = isAdminRole(session.user.role);

  if (!res.ok)
    return (
      <div className="grid gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <Notice tone="error">Reports couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );

  const { sites, recent, previousMonth } = res.data;

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Monthly report per website: issues, actions and time to fix, then updates, backups,
          security and uptime. Reports for {previousMonth.label} generate automatically on the 1st
          of each month (UTC).
        </p>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Sites</h2>
          <p className="text-xs text-muted-foreground">
            One report per active site for {previousMonth.label}.
          </p>
        </div>
        {sites.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">No active sites yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Site</th>
                  <th className="px-4 py-2 font-medium">Last report</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.siteId} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/sites/${s.siteId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {s.siteName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{s.siteUrl}</p>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {s.lastReport ? (
                        <Link
                          href={`/reports/${s.lastReport.id}`}
                          className="text-primary hover:underline"
                        >
                          {s.lastReport.label}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {admin ? (
                        <GenerateReportButton
                          siteId={s.siteId}
                          periodStart={previousMonth.start}
                          label={previousMonth.label}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Recent reports</h2>
        </div>
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">No reports generated yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Site</th>
                  <th className="px-4 py-2 font-medium">Period</th>
                  <th className="px-4 py-2 font-medium">Generated</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <Link
                        href={`/reports/${r.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {r.siteName}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.label}</td>
                    <td
                      className="px-4 py-2 text-muted-foreground"
                      title={formatUtc(r.generatedAt)}
                    >
                      {timeAgo(r.generatedAt)}
                    </td>
                    <td className="px-4 py-2">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
