import { AlertList, ApprovalList, AuditPage, can, DeploymentList, SiteList } from "@ulixops/shared";
import type { z } from "zod";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet, apiHealthy } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALERT_LABELS: Record<string, string> = {
  NEW_DEVICE_LOGIN: "Sign-in from a new device",
  ACCOUNT_LOCKED: "Account locked after failed attempts",
  ADMIN_ROLE_GRANTED: "Admin role granted",
  TWO_FACTOR_RESET: "Two-factor authentication reset",
  HOST_KEY_MISMATCH: "A site's SSH host key changed",
};

// Spec screen 2. Values shown as — are filled in as the steps that produce them land.
const STATS = [
  { label: "Sites", hint: "Active sites" },
  { label: "Vulnerabilities", hint: "Scanning · Phase 2" },
  { label: "Updates pending", hint: "Plugins and themes, production" },
  { label: "Last backup", hint: "Snapshots · step 8" },
  { label: "Sites down", hint: "Monitoring · Phase 3" },
];

/** Plugin and theme updates on production, from each site's last inventory. */
function updatesPending({ sites }: z.infer<typeof SiteList>): string {
  const read = sites
    .map((site) => site.environments.find((e) => e.kind === "PRODUCTION")?.inventory)
    .filter((inv) => inv != null);
  if (read.length === 0) return "—";
  return String(read.reduce((sum, inv) => sum + inv.pluginUpdates + inv.themeUpdates, 0));
}

export default async function DashboardPage() {
  const { user } = await requireSession();
  const admin = can(user.role, "audit.view");
  const auth = await apiAuth();
  const [healthy, alerts, activity, sites, approvals, deployments] = await Promise.all([
    apiHealthy(),
    admin ? apiGet("/alerts?limit=5", AlertList, auth) : null,
    admin ? apiGet("/audit?limit=6", AuditPage, auth) : null,
    can(user.role, "sites.view") ? apiGet("/sites", SiteList, auth) : null,
    can(user.role, "approvals.decide") ? apiGet("/approvals", ApprovalList, auth) : null,
    can(user.role, "deployments.view") ? apiGet("/deployments", DeploymentList, auth) : null,
  ]);
  const live = deployments?.ok
    ? deployments.data.deployments.filter((d) =>
        ["QUEUED", "RUNNING", "PAUSED", "PENDING_APPROVAL"].includes(d.status),
      )
    : [];
  const values: Record<string, string> = {
    Sites: sites?.ok ? String(sites.data.sites.length) : "—",
    "Updates pending": sites?.ok ? updatesPending(sites.data) : "—",
  };
  const waiting = approvals?.ok ? approvals.data.pending : null;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{user.name ? `, ${user.name}` : ""}.
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
            healthy ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          API {healthy ? "healthy" : "unreachable"}
        </span>
      </div>

      <section aria-label="Overview" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {STATS.map((stat) => (
          <Card key={stat.label} className="p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              {values[stat.label] ?? "—"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">{stat.hint}</p>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="grid gap-1.5">
              <CardTitle className="text-base">Live deployments</CardTitle>
              <CardDescription>
                Staging-first, phased rollouts with automatic rollback.
              </CardDescription>
            </div>
            {can(user.role, "deployments.view") && (
              <Link href="/deployments" className="text-sm text-link hover:underline">
                All
              </Link>
            )}
          </CardHeader>
          <CardContent>
            {live.length > 0 ? (
              <ul className="grid gap-2 text-sm">
                {live.slice(0, 5).map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-3">
                    <Link href={`/deployments/${d.id}`} className="min-w-0 hover:underline">
                      {d.pluginName}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{d.version}</span>
                      <span className="block text-xs text-muted-foreground">
                        {d.status.replaceAll("_", " ")} · {d.targets.length} targets
                      </span>
                    </Link>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">
                      {timeAgo(d.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No deployments in progress.</p>
            )}
          </CardContent>
        </Card>

        {waiting && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="grid gap-1.5">
                <CardTitle className="text-base">Approvals waiting</CardTitle>
                <CardDescription>Risky changes need a second Admin.</CardDescription>
              </div>
              <Link href="/approvals" className="text-sm text-link hover:underline">
                Open
              </Link>
            </CardHeader>
            <CardContent>
              {waiting.length > 0 ? (
                <ul className="grid gap-2 text-sm">
                  {waiting.slice(0, 5).map((request) => (
                    <li key={request.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {request.summary}
                        <span className="block text-xs text-muted-foreground">
                          {request.ownRequest ? "Your request" : request.requestedBy?.email}
                        </span>
                      </span>
                      <span className="text-xs whitespace-nowrap text-muted-foreground">
                        {timeAgo(request.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing waiting.</p>
              )}
            </CardContent>
          </Card>
        )}

        {admin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent security alerts</CardTitle>
              <CardDescription>
                New devices, lockouts, new Admins, 2FA resets and changed host keys.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {alerts?.ok && alerts.data.alerts.length > 0 ? (
                <ul className="grid gap-2 text-sm">
                  {alerts.data.alerts.map((alert) => (
                    <li key={alert.id} className="flex items-start justify-between gap-3">
                      <span>
                        {ALERT_LABELS[alert.kind] ?? alert.kind}
                        <span className="block text-xs text-muted-foreground">
                          {alert.user?.email ?? "unknown user"} · {alert.ip ?? "no IP"}
                        </span>
                      </span>
                      <span
                        className="text-xs whitespace-nowrap text-muted-foreground"
                        title={formatUtc(alert.createdAt)}
                      >
                        {timeAgo(alert.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No alerts. All quiet.</p>
              )}
            </CardContent>
          </Card>
        )}

        {admin && activity?.ok && (
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="grid gap-1.5">
                <CardTitle className="text-base">Recent activity</CardTitle>
                <CardDescription>The latest entries in the audit log.</CardDescription>
              </div>
              <Link href="/audit" className="text-sm text-link hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2 text-sm">
                {activity.data.entries.map((entry) => (
                  <li key={entry.id} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-xs">{entry.action}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {entry.user?.email ?? "system"}
                      </span>
                    </span>
                    <span
                      className="text-xs whitespace-nowrap text-muted-foreground"
                      title={formatUtc(entry.createdAt)}
                    >
                      {timeAgo(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
