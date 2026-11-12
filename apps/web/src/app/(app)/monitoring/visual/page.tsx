// Monitoring → Visual checks (P4-3, A163): before/after screenshots around deploys and updates.
import { isAdminRole, isClientViewer, VisualOverview } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MonitoringTabs } from "../monitoring-tabs";
import { VisualSettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Visual checks · UlixOps" };

const STATUS_TONE: Record<string, string> = {
  CLEAN: "text-emerald-700 dark:text-emerald-400",
  CHANGED: "text-amber-700 dark:text-amber-400",
  FAILED: "text-destructive",
  SKIPPED: "text-muted-foreground",
};

export default async function VisualChecksPage() {
  const session = await requireSession();
  if (isClientViewer(session.user.role)) {
    return <NoAccess role={session.user.role} what="visual checks" />;
  }
  const res = await apiGet("/visual-checks/overview", VisualOverview, await apiAuth(), {
    timeoutMs: 15_000,
  });
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Before and after screenshots of each site&apos;s public pages around deploys and updates.
          A pixel diff highlights what changed; it alerts but does not roll back.
        </p>
      </div>
      <MonitoringTabs active="/monitoring/visual" />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">Visual checks couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { recent, changedOpen, checkedToday, settings } = res.data;
  const tiles = [
    { label: "Changed (open)", value: String(changedOpen) },
    { label: "Checked today", value: String(checkedToday) },
    { label: "On deploys/updates", value: settings.enabled ? "On" : "Off" },
    { label: "Diff limit", value: `${settings.maxDiffPercent}%` },
  ];

  return (
    <div className="grid gap-4">
      {header}
      <section aria-label="Visual summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
          </Card>
        ))}
      </section>

      {isAdminRole(session.user.role) ? <VisualSettingsForm settings={settings} /> : null}

      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Recent checks</h2>
          <p className="text-xs text-muted-foreground">
            Homepage and Settings → Health check extra paths. Click a row for before / after / diff.
          </p>
        </div>
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            No visual checks yet. They run automatically on the next deploy or update, or use Check
            now on a site&apos;s Visual checks tab.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Site</th>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Trigger</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <Link
                        href={`/monitoring/visual/${c.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {c.siteName}
                      </Link>
                      <span className="ml-1 text-xs text-muted-foreground">
                        {c.environment === "STAGING" ? "staging" : "live"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground" title={formatUtc(c.startedAt)}>
                      {timeAgo(c.startedAt)}
                    </td>
                    <td className="px-4 py-2 capitalize text-muted-foreground">
                      {c.trigger.replace("_", " ")}
                    </td>
                    <td className={cn("px-4 py-2 font-medium", STATUS_TONE[c.status] ?? "")}>
                      {c.status}
                      {c.changedPages > 0 ? (
                        <span className="ml-1 text-xs font-normal">
                          ({c.changedPages}/{c.pageCount})
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2 text-muted-foreground">
                      {c.summary}
                    </td>
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
