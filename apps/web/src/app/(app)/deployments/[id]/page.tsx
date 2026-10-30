// Spec screen 10: live deployment progress per target.
import { can, DeploymentResponse, RecordId, type DeploymentView } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STATUS_TONE, TARGET_TONE } from "../status";
import { DeploymentControls } from "./controls";
import { LiveRefresh } from "./live-refresh";

export const metadata: Metadata = { title: "Deployment · UlixOps" };

const ACTIVE = new Set(["QUEUED", "RUNNING", "PENDING_APPROVAL", "PAUSED"]);

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  if (!can(user.role, "deployments.view")) return <NoAccess role={user.role} what="deployments" />;
  const { id } = await params;
  if (!RecordId.safeParse(id).success) notFound();
  const res = await apiGet(`/deployments/${id}`, DeploymentResponse, await apiAuth());
  if (!res.ok) notFound();
  const d = res.data.deployment;
  const canControl = can(user.role, "deploy.single");

  return (
    <div className="grid gap-4">
      {ACTIVE.has(d.status) && <LiveRefresh />}
      <Link href="/deployments" className="text-sm text-muted-foreground hover:text-foreground">
        ← Deployments
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {d.pluginName}{" "}
            <span className="font-mono text-base text-muted-foreground">{d.version}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Requested by {d.requestedBy?.email ?? "removed user"}{" "}
            <span title={formatUtc(d.createdAt)}>{timeAgo(d.createdAt)}</span>
            {d.approvedBy && <> · approved by {d.approvedBy.email}</>}
          </p>
        </div>
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide",
            STATUS_TONE[d.status],
          )}
        >
          {d.status.replaceAll("_", " ")}
        </span>
      </div>

      {d.status === "PENDING_APPROVAL" && (
        <Notice>
          Waiting for another Admin on{" "}
          <Link href="/approvals" className="underline">
            Approvals
          </Link>
          .
        </Notice>
      )}

      {canControl && <DeploymentControls deployment={d} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Targets</CardTitle>
          <CardDescription>
            Staging first{d.stagingFirst ? " on" : " off"} · batch {d.batchSize} · pause on failure{" "}
            {d.pauseOnFailure ? "on" : "off"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {d.targets.map((t) => (
            <TargetRow key={t.id} target={t} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function TargetRow({ target }: { target: DeploymentView["targets"][number] }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {target.siteName}{" "}
            <span className="text-xs font-normal text-muted-foreground">{target.kind}</span>
          </p>
        </div>
        <span
          className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", TARGET_TONE[target.status])}
        >
          {target.status.replaceAll("_", " ")}
        </span>
      </div>
      {target.log && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
          {target.log}
        </pre>
      )}
    </div>
  );
}
