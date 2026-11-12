import { isClientViewer, VisualCheckListItem } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { NoAccess } from "@/components/no-access";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import { cn } from "@/lib/utils";
import { RunVisualButton } from "./run-button";

export const metadata: Metadata = { title: "Visual checks · UlixOps" };

const List = z.object({ checks: z.array(VisualCheckListItem) });

export default async function SiteVisualPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { user } = await requireSession();
  if (isClientViewer(user.role)) {
    return <NoAccess role={user.role} what="visual checks" />;
  }
  const { id } = await params;
  const envParam = (await searchParams).env === "staging" ? "STAGING" : "PRODUCTION";
  const site = await loadSite(id);
  const res = await apiGet(`/sites/${id}/visual-checks`, List, await apiAuth(), {
    timeoutMs: 15_000,
  });

  const checks = res.ok ? res.data.checks.filter((c) => c.environment === envParam) : [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Visual checks</h2>
          <p className="text-sm text-muted-foreground">
            Before/after screenshots of public pages around deploys and updates for this
            environment. Diffs alert; they never roll back on their own.
          </p>
        </div>
        <RunVisualButton siteId={id} kind={envParam} />
      </div>

      {!res.ok ? (
        <Notice tone="error">Visual checks couldn&apos;t be loaded.</Notice>
      ) : checks.length === 0 ? (
        <Notice>
          No checks for {site.name} ({envParam === "STAGING" ? "staging" : "live"}) yet.
        </Notice>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Trigger</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2" title={formatUtc(c.startedAt)}>
                    <Link
                      href={`/monitoring/visual/${c.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {timeAgo(c.startedAt)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 capitalize text-muted-foreground">
                    {c.trigger.replace("_", " ")}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 font-medium",
                      c.status === "CHANGED" && "text-amber-700 dark:text-amber-400",
                      c.status === "FAILED" && "text-destructive",
                      c.status === "CLEAN" && "text-emerald-700 dark:text-emerald-400",
                    )}
                  >
                    {c.status}
                  </td>
                  <td className="max-w-sm truncate px-4 py-2 text-muted-foreground">{c.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
