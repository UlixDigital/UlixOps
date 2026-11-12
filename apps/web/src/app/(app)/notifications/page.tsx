// Spec screen 19: in-app alert centre.
import {
  ALERT_RESOLUTION_LABELS,
  can,
  FIX_ACTION_LABELS,
  isClientViewer,
  NotificationList,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEvent,
  type NotificationView,
} from "@ulixops/shared";
import Link from "next/link";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { AlertStatusBadge, SEVERITY_BADGE } from "@/components/alert-status";
import { cn } from "@/lib/utils";
import { MarkAllRead, MarkReadButton } from "./actions-ui";
import { MarkSeenOnView, ResolveAlertDialog, TakeAlertButton } from "./followup-ui";

export const metadata: Metadata = { title: "Notifications · UlixOps" };

/** Who has it and what was done, in one line under the notification. */
function FollowupLine({ n }: { n: NotificationView }) {
  const a = n.alert;
  if (!a?.actionable) return null;
  const parts: string[] = [];
  if (a.occurrences > 1) parts.push(`reported ${a.occurrences} times`);
  if (a.status === "ACKNOWLEDGED" && a.ownerName)
    parts.push(a.ownerIsMe ? "you're on it" : `${a.ownerName} is on it`);
  if ((a.status === "RESOLVED" || a.status === "VERIFIED") && a.resolvedByName)
    parts.push(
      `${a.resolution ? ALERT_RESOLUTION_LABELS[a.resolution] : "Fixed"} by ${a.resolvedByName}${a.fixAction ? `: ${FIX_ACTION_LABELS[a.fixAction].toLowerCase()}` : ""}`,
    );
  else if (a.status === "VERIFIED") parts.push("Fixed · confirmed by UlixOps");
  else if (a.status === "AUTO_CLEARED") parts.push("Problem gone · closed automatically");
  if (a.status === "RESOLVED")
    parts.push(a.autoVerify ? "UlixOps re-checks it" : "waiting for a Super Admin to confirm");
  return (
    <div className="mt-1 grid gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AlertStatusBadge status={a.status} />
        {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      </div>
      {a.resolutionNote && (a.status === "RESOLVED" || a.status === "VERIFIED") && (
        <p className="text-xs whitespace-pre-line text-muted-foreground">“{a.resolutionNote}”</p>
      )}
      {a.status === "OPEN" && a.lastRejectNote && (
        <p className="text-xs text-destructive">
          Previous fix didn&apos;t hold: {a.lastRejectNote}
        </p>
      )}
    </div>
  );
}

function FollowupActions({ n }: { n: NotificationView }) {
  const a = n.alert;
  if (!a?.actionable || (a.status !== "OPEN" && a.status !== "ACKNOWLEDGED")) return null;
  if (n.kind === "approval.requested")
    return (
      <Link
        href="/approvals"
        className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
      >
        Decide
      </Link>
    );
  return (
    <>
      {!a.ownerIsMe && <TakeAlertButton alertId={a.id} takeOver={a.status === "ACKNOWLEDGED"} />}
      <ResolveAlertDialog alertId={a.id} title={n.title} autoVerify={a.autoVerify} />
    </>
  );
}

export default async function NotificationsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "notifications.view") || isClientViewer(user.role))
    return <NoAccess role={user.role} what="notifications" />;
  const res = await apiGet("/notifications?limit=50", NotificationList, await apiAuth());
  if (!res.ok)
    return <Notice tone="error">Notifications couldn&apos;t be loaded. Refresh the page.</Notice>;
  const { notifications, unreadCount } = res.data;
  const unseen = notifications.filter((n) => !n.seenAt).map((n) => n.id);

  return (
    <div className="grid gap-6">
      <MarkSeenOnView ids={unseen} />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {unreadCount === 0
              ? "In-app alerts for deployments, approvals and security events."
              : `${unreadCount} unread`}
          </p>
        </div>
        {unreadCount > 0 && <MarkAllRead />}
      </div>

      {notifications.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">All quiet</CardTitle>
            <CardDescription>
              Deployment, approval and security alerts will show up here. Admins can choose which
              events also go to email and Slack in Settings.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="divide-y rounded-lg border">
          {notifications.map((n) => (
            <li
              key={n.id}
              id={`n-${n.id}`}
              className={cn("grid scroll-mt-20 gap-1 px-4 py-3", !n.readAt && "bg-primary/5")}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-sm break-words whitespace-pre-line text-muted-foreground">
                    {n.body}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {NOTIFICATION_EVENT_LABELS[n.kind as NotificationEvent] ?? n.kind} ·{" "}
                    <span title={formatUtc(n.createdAt)}>{timeAgo(n.createdAt)}</span>
                  </p>
                  <FollowupLine n={n} />
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-xs font-medium",
                      "mt-1.5",
                      SEVERITY_BADGE[n.severity] ?? SEVERITY_BADGE.info,
                    )}
                  >
                    {n.severity}
                  </span>
                  <FollowupActions n={n} />
                  {!n.readAt && <MarkReadButton id={n.id} />}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
