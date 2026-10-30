// Spec screen 11: deployment history. Live rollouts link to the progress view.
import { can, DeploymentList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "./status";

export const metadata: Metadata = { title: "Deployments · UlixOps" };

export default async function DeploymentsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "deployments.view")) return <NoAccess role={user.role} what="deployments" />;
  const res = await apiGet("/deployments", DeploymentList, await apiAuth());
  if (!res.ok)
    return <Notice tone="error">Deployments couldn&apos;t be loaded. Refresh the page.</Notice>;
  const { deployments } = res.data;
  const canStart = can(user.role, "deploy.single") || can(user.role, "deploy.bulk.request");

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Deployments</h1>
          <p className="text-sm text-muted-foreground">
            Staging-first, phased rollouts with automatic rollback on failed health checks.
          </p>
        </div>
        {canStart && (
          <Link href="/deployments/new" className={buttonVariants()}>
            New deployment
          </Link>
        )}
      </div>

      {deployments.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No deployments yet</CardTitle>
            <CardDescription>
              {canStart
                ? "Pick a plugin version and sites in the deploy wizard."
                : "Developers and Admins start rollouts from here."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="divide-y rounded-lg border">
          {deployments.map((d) => {
            const done = d.targets.filter((t) => t.status === "DONE").length;
            return (
              <li key={d.id}>
                <Link
                  href={`/deployments/${d.id}`}
                  className="grid gap-1 px-4 py-3 transition-colors hover:bg-muted/40"
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
                    >
                      {d.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {done}/{d.targets.length} targets done · requested by{" "}
                    {d.requestedBy?.email ?? "removed user"}{" "}
                    <span title={formatUtc(d.createdAt)}>{timeAgo(d.createdAt)}</span>
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
