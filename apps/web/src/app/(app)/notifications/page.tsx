// Spec screen 19: in-app alert centre.
import {
  can,
  NotificationList,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEvent,
} from "@ulixops/shared";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MarkAllRead, MarkReadButton } from "./actions-ui";

export const metadata: Metadata = { title: "Notifications · UlixOps" };

const SEVERITY: Record<string, string> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-warning/10 text-warning",
  critical: "bg-destructive/10 text-destructive",
};

export default async function NotificationsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "notifications.view"))
    return <NoAccess role={user.role} what="notifications" />;
  const res = await apiGet("/notifications?limit=50", NotificationList, await apiAuth());
  if (!res.ok)
    return <Notice tone="error">Notifications couldn&apos;t be loaded. Refresh the page.</Notice>;
  const { notifications, unreadCount } = res.data;

  return (
    <div className="grid gap-6">
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
            <li key={n.id} className={cn("grid gap-1 px-4 py-3", !n.readAt && "bg-primary/5")}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-sm text-muted-foreground">{n.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {NOTIFICATION_EVENT_LABELS[n.kind as NotificationEvent] ?? n.kind} ·{" "}
                    <span title={formatUtc(n.createdAt)}>{timeAgo(n.createdAt)}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-xs font-medium",
                      SEVERITY[n.severity] ?? SEVERITY.info,
                    )}
                  >
                    {n.severity}
                  </span>
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
