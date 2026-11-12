import { CredentialList, SettingsView } from "@ulixops/shared";
import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { HealthCheckForm } from "./health-form";
import { NotificationsForm } from "./notifications-form";
import { RetentionForm } from "./retention-form";

export const metadata: Metadata = { title: "Settings · UlixOps" };

const STATUS = {
  configured: { label: "Configured", tone: "bg-success/10 text-success" },
  not_configured: { label: "Not configured", tone: "bg-muted text-muted-foreground" },
  planned: { label: "Planned", tone: "bg-muted text-muted-foreground" },
} as const;

export default async function GeneralSettingsPage() {
  const auth = await apiAuth();
  const [res, vault] = await Promise.all([
    apiGet("/settings", SettingsView, auth),
    // Only the runner holds the vault login, so ask it (a live check, not a config flag).
    apiGet("/credentials", CredentialList, auth, { timeoutMs: 15_000 }).then(
      (r) => r.ok,
      () => false,
    ),
  ]);
  if (!res.ok) return <Notice tone="error">Settings couldn't be loaded. Refresh the page.</Notice>;
  const { policy } = res.data;
  const integrations = res.data.integrations.map((item) =>
    item.key === "vault"
      ? {
          ...item,
          status: vault ? ("configured" as const) : ("not_configured" as const),
          note: vault
            ? "The runner reached the vault just now"
            : "The runner couldn't reach the vault",
        }
      : item,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Integrations</CardTitle>
          <CardDescription>
            Credentials live in the server environment or the vault, never here. This page only
            shows whether each one is set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border">
            {integrations.map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-medium">{item.name}</span>
                  <span className="block text-xs text-muted-foreground">{item.note}</span>
                </span>
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-medium",
                    STATUS[item.status].tone,
                  )}
                >
                  {STATUS[item.status].label}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sign-in policy</CardTitle>
          <CardDescription>Fixed by the security requirements (spec section 5).</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[1fr_auto] gap-2 text-sm">
            <dt className="text-muted-foreground">Idle timeout</dt>
            <dd>{policy.idleMinutes} minutes</dd>
            <dt className="text-muted-foreground">Maximum session</dt>
            <dd>{policy.absoluteHours} hours</dd>
            <dt className="text-muted-foreground">Lockout</dt>
            <dd>
              after {policy.lockAfterFailures} failures, for {policy.lockMinutes} minutes
            </dd>
            <dt className="text-muted-foreground">Two-factor authentication</dt>
            <dd>Required for everyone</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Snapshot retention</CardTitle>
          <CardDescription>
            How long quick pre-update snapshots are kept before they are deleted automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RetentionForm days={res.data.snapshotRetentionDays} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Health checks</CardTitle>
          <CardDescription>
            The homepage is always checked; wp-admin only if switched on below. Extra paths,
            response-time threshold, and optional debug.log scanning apply to every site (spec
            §6.6).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HealthCheckForm value={res.data.healthCheck} />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
          <CardDescription>
            In-app alerts always appear in the alert centre. Choose which events also go to email
            and Slack (spec §6.8). Credentials stay in the server environment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationsForm
            prefs={res.data.notificationPrefs}
            configured={{
              email: integrations.find((i) => i.key === "smtp")?.status === "configured",
              slack: integrations.find((i) => i.key === "slack")?.status === "configured",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
