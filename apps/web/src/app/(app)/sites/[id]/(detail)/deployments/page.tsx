// Spec screen 5, Deployments tab: this site's rollout history (step 10). Each row shows how the
// rollout went on this site's own environments and links to the full live view.
import { can, DeploymentList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { STATUS_TONE, TARGET_TONE } from "@/app/(app)/deployments/status";
import { EnvBadge } from "@/components/env-badge";
import { NoAccess } from "@/components/no-access";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Site deployments · UlixOps" };

export default async function SiteDeploymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  if (!can(user.role, "deployments.view")) return <NoAccess role={user.role} what="deployments" />;
  const site = await loadSite((await params).id);
  const res = await apiGet(`/deployments?siteId=${site.id}`, DeploymentList, await apiAuth());
  const canStart =
    !site.archived && (can(user.role, "deploy.single") || can(user.role, "deploy.bulk.request"));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">Deployments</CardTitle>
          <CardDescription>
            Plugin rollouts that included this site, newest first (the last 50).{" "}
            <Link href="/deployments" className="text-link hover:underline">
              All deployments
            </Link>
          </CardDescription>
        </div>
        {canStart && (
          <Link
            href={`/deployments/new?site=${site.id}`}
            className={buttonVariants({ variant: "outline" })}
          >
            Deploy to this site
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {!res.ok ? (
          <Notice tone="error">Deployments couldn&apos;t be loaded. Refresh the page.</Notice>
        ) : res.data.deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No deployments to this site yet.
            {canStart && " Use “Deploy to this site” to roll out one of our plugins."}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {res.data.deployments.map((d) => {
              const mine = d.targets.filter((t) => t.siteId === site.id);
              return (
                <li key={d.id}>
                  <Link
                    href={`/deployments/${d.id}`}
                    className="grid gap-1.5 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {d.pluginName}{" "}
                        <span className="font-mono text-sm text-muted-foreground">{d.version}</span>
                      </span>
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-xs font-medium",
                          STATUS_TONE[d.status],
                        )}
                        title="Status of the whole rollout"
                      >
                        {d.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {mine.map((t) => (
                        <span key={t.id} className="flex items-center gap-1">
                          <EnvBadge kind={t.kind} />
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-xs font-medium",
                              TARGET_TONE[t.status],
                            )}
                          >
                            {t.status.replaceAll("_", " ")}
                          </span>
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {d.targets.length > mine.length &&
                        `Part of a rollout to ${new Set(d.targets.map((t) => t.siteId)).size} sites · `}
                      requested by {d.requestedBy?.email ?? "removed user"}{" "}
                      <span title={formatUtc(d.createdAt)}>{timeAgo(d.createdAt)}</span>
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
