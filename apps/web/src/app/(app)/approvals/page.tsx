// Spec screen 12: pending requests with details; approve or reject with a comment. The
// requester sees their own requests but can't decide them.
import { ApprovalList, type ApprovalView, can } from "@ulixops/shared";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ApprovalBulkItems } from "./bulk-items";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Approvals · UlixOps" };

const ACTION_LABELS: Record<string, string> = {
  "site.connection.change": "Site connection change",
  "site.hostkey.reset": "Host key reset",
  "deploy.bulk": "Bulk deployment",
  "site.archive": "Archive site",
  "site.bulk_update": "Bulk plugin/theme update",
};

function Who({ request }: { request: ApprovalView }) {
  return (
    <p className="text-xs text-muted-foreground">
      Requested by {request.requestedBy?.email ?? "a removed user"}{" "}
      <span title={formatUtc(request.createdAt)}>{timeAgo(request.createdAt)}</span>
    </p>
  );
}

export default async function ApprovalsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "approvals.decide")) return <NoAccess role={user.role} what="approvals" />;
  const res = await apiGet("/approvals", ApprovalList, await apiAuth());
  if (!res.ok)
    return <Notice tone="error">Approvals couldn&apos;t be loaded. Refresh the page.</Notice>;
  const { pending, recent } = res.data;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Risky changes wait here for a second Admin. Nobody can approve their own request.
        </p>
      </div>

      <section className="grid gap-3">
        <h2 className="text-base font-semibold">Waiting ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing is waiting for a decision.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((request) => (
              <Card key={request.id}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {ACTION_LABELS[request.action] ?? request.action}
                  </CardTitle>
                  <CardDescription className="break-words">{request.summary}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <Who request={request} />
                  {request.bulkItems && request.bulkItems.length > 0 && (
                    <ApprovalBulkItems items={request.bulkItems} />
                  )}
                  {request.ownRequest ? (
                    <Notice>Your request: another Admin must approve or reject it.</Notice>
                  ) : (
                    <DecisionForm
                      requestId={request.id}
                      summary={request.summary}
                      bulkUpdate={request.action === "site.bulk_update"}
                    />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-base font-semibold">Recently decided</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {recent.map((request) => (
              <li key={request.id} className="grid gap-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words">{request.summary}</span>
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-xs font-medium",
                      request.status === "APPROVED"
                        ? "bg-success/10 text-success"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {request.status === "APPROVED" ? "Approved" : "Rejected"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {request.requestedBy?.email ?? "removed user"} asked · decided by{" "}
                  {request.decidedBy?.email ?? "UlixOps"}{" "}
                  <span title={formatUtc(request.decidedAt)}>{timeAgo(request.decidedAt)}</span>
                  {request.comment && <> · “{request.comment}”</>}
                </p>
                {request.bulkItems && request.bulkItems.length > 0 && (
                  <div className="mt-2">
                    <ApprovalBulkItems items={request.bulkItems} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
