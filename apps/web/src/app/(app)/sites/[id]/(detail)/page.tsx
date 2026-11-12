// Spec screen 5, Overview: per environment, the connection (Test connection, pinned host key),
// inventory summary, and health (step 9); the site's last deploy (step 10) and last full backup
// on Google Drive (A145).
import { can, DeploymentList, FullBackupList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { STATUS_TONE } from "@/app/(app)/deployments/status";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import {
  connectionStatus,
  ENV_LABELS,
  healthStatus,
  phpStatus,
  siteHealthStatus,
} from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { resetHostKeyAction } from "../../actions";
import { AutoTestOnLoad } from "./auto-test";
import { Badge, CheckInventoryUpdates, RefreshInventory, remoteBlocker } from "./parts";
import { RunHealthCheck } from "./run-health-check";
import { TestConnection } from "./test-connection";

export const metadata: Metadata = { title: "Site · UlixOps" };

/** Plugin, theme and WordPress core updates from the last check (A135). */
function updateCount(inv: {
  pluginUpdates: number;
  themeUpdates: number;
  coreUpdateVersion?: string | null;
}) {
  return inv.pluginUpdates + inv.themeUpdates + (inv.coreUpdateVersion ? 1 : 0);
}

export default async function SiteOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autotest?: string }>;
}) {
  const { user } = await requireSession();
  const site = await loadSite((await params).id);
  const autotest = (await searchParams).autotest === "1";
  const manage = can(user.role, "sites.manage");
  const refresh = can(user.role, "sites.refresh");
  const hidden = <input type="hidden" name="siteId" value={site.id} />;
  const overall = siteHealthStatus(site);
  const production = site.environments.find((e) => e.kind === "PRODUCTION");
  const healthHint = production?.lastHealthAt
    ? `Checked ${timeAgo(production.lastHealthAt)}`
    : "Not checked yet";
  const testKinds = site.environments.map((e) => e.kind);
  const auth = await apiAuth();
  const [deploys, backups] = await Promise.all([
    can(user.role, "deployments.view")
      ? apiGet(`/deployments?siteId=${site.id}&limit=1`, DeploymentList, auth)
      : null,
    apiGet(`/full-backups?siteId=${site.id}&status=READY&limit=1`, FullBackupList, auth),
  ]);
  const lastDeploy = deploys?.ok ? (deploys.data.deployments[0] ?? null) : null;
  const lastBackup = backups.ok ? (backups.data.backups[0] ?? null) : null;

  return (
    <div className="grid gap-4">
      {autotest && manage && <AutoTestOnLoad siteId={site.id} kinds={testKinds} />}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-3">
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">Health</span>
            <span className={cn("text-lg font-semibold", overall.tone.split(" ").pop())}>
              {overall.label}
            </span>
            <span
              className="text-xs text-muted-foreground"
              title={production?.lastHealthSummary ?? undefined}
            >
              {healthHint}
            </span>
          </div>
          <div className="grid min-w-0 gap-0.5">
            <span className="text-xs text-muted-foreground">Last deploy</span>
            {lastDeploy ? (
              <>
                <Link
                  href={`/deployments/${lastDeploy.id}`}
                  className="truncate text-lg font-semibold hover:underline"
                  title={`${lastDeploy.pluginName} ${lastDeploy.version}`}
                >
                  {lastDeploy.pluginName} {lastDeploy.version}
                </Link>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 font-medium",
                      STATUS_TONE[lastDeploy.status],
                    )}
                  >
                    {lastDeploy.status.replaceAll("_", " ")}
                  </span>
                  <span title={formatUtc(lastDeploy.createdAt)}>
                    {timeAgo(lastDeploy.createdAt)}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="text-lg font-semibold">—</span>
                <span className="text-xs text-muted-foreground">
                  {deploys === null ? (
                    "Deployments aren't visible to your role"
                  ) : deploys.ok ? (
                    <Link href={`/sites/${site.id}/deployments`} className="hover:underline">
                      No deployments to this site yet
                    </Link>
                  ) : (
                    "Couldn't load deployments"
                  )}
                </span>
              </>
            )}
          </div>
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">Last backup</span>
            {lastBackup ? (
              <>
                <span
                  className="text-lg font-semibold"
                  title={formatUtc(lastBackup.finishedAt ?? lastBackup.startedAt)}
                >
                  {timeAgo(lastBackup.finishedAt ?? lastBackup.startedAt)}
                </span>
                <span className="text-xs text-muted-foreground">
                  Full backup on Google Drive
                  {lastBackup.environment === "STAGING" ? " (staging)" : ""} ·{" "}
                  <Link href={`/sites/${site.id}/snapshots`} className="hover:underline">
                    snapshots
                  </Link>
                </span>
              </>
            ) : (
              <>
                <span className="text-lg font-semibold">—</span>
                <span className="text-xs text-muted-foreground">
                  {backups.ok ? "No full backup on Drive yet · " : "Couldn't load backups · "}
                  <Link href={`/sites/${site.id}/snapshots`} className="hover:underline">
                    snapshots
                  </Link>
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {site.environments.map((env) => {
          const status = connectionStatus(env);
          const health = healthStatus(env);
          const inv = env.inventory;
          const blocked = remoteBlocker(site, env);
          return (
            <Card key={env.kind}>
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div className="grid gap-1.5">
                  <CardTitle className="text-base">{ENV_LABELS[env.kind]}</CardTitle>
                  <CardDescription>
                    {env.lastTestAt ? (
                      <span title={formatUtc(env.lastTestAt)}>
                        Last tested {timeAgo(env.lastTestAt)}
                      </span>
                    ) : (
                      "Never tested"
                    )}
                  </CardDescription>
                </div>
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
                    {status.label}
                  </span>
                  <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", health.tone)}>
                    {health.label}
                  </span>
                </span>
              </CardHeader>
              <CardContent className="grid gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">URL</dt>
                  <dd className="break-all">{env.url}</dd>
                  <dt className="text-muted-foreground">Health</dt>
                  <dd>
                    {env.lastHealthAt ? (
                      <span title={formatUtc(env.lastHealthAt)}>
                        {health.label}
                        {env.lastHealthSummary ? ` — ${env.lastHealthSummary}` : ""} ·{" "}
                        {timeAgo(env.lastHealthAt)}
                      </span>
                    ) : (
                      "Not checked yet"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">SSH</dt>
                  <dd className="font-mono text-xs break-all">
                    {env.sshUser}@{env.sshHost}:{env.sshPort}
                  </dd>
                  <dt className="text-muted-foreground">WordPress path</dt>
                  <dd className="font-mono text-xs break-all">{env.wpPath}</dd>
                  <dt className="text-muted-foreground">SSH key</dt>
                  <dd className="font-mono text-xs">{env.credentialRef}</dd>
                  <dt className="text-muted-foreground">Host key</dt>
                  <dd className="font-mono text-xs break-all">
                    {env.hostKey ?? (
                      <span className="font-sans">Pinned on the first successful test</span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Versions</dt>
                  <dd>
                    {env.wpVersion
                      ? `WordPress ${env.wpVersion} · PHP ${env.phpVersion ?? "?"} · WP-CLI ${env.wpCliVersion ?? "?"}`
                      : "—"}
                  </dd>
                  <dt className="text-muted-foreground">PHP support</dt>
                  <dd>
                    {env.phpVersion ? (
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-xs font-medium",
                          phpStatus(env.phpVersion).tone,
                        )}
                        title={phpStatus(env.phpVersion).title}
                      >
                        PHP {env.phpVersion} · {phpStatus(env.phpVersion).label}
                      </span>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Active theme</dt>
                  <dd>{inv?.activeTheme ?? "—"}</dd>
                  <dt className="text-muted-foreground">Plugins</dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
                    {inv ? (
                      <>
                        <Link
                          href={`/sites/${site.id}/plugins${env.kind === "STAGING" ? "?env=staging" : ""}`}
                          className="text-link hover:underline"
                        >
                          {inv.plugins} installed
                        </Link>
                        {updateCount(inv) > 0 && (
                          <Badge tone="warning">
                            {updateCount(inv)} update
                            {updateCount(inv) === 1 ? "" : "s"} available
                          </Badge>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Maintenance</dt>
                  <dd>
                    {inv?.maintenance === true ? (
                      <Badge tone="warning">On: visitors see the maintenance page</Badge>
                    ) : inv?.maintenance === false ? (
                      "Off"
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Inventory</dt>
                  <dd>
                    {inv ? (
                      <span title={formatUtc(inv.refreshedAt)}>
                        Read {timeAgo(inv.refreshedAt)}
                      </span>
                    ) : (
                      "Not read yet"
                    )}
                  </dd>
                </dl>
                {inv?.safeMode && (
                  <Notice tone="error">
                    WP-CLI crashed with plugins loaded, so the last inventory was read with plugins
                    and themes skipped. A plugin may be breaking the site: see{" "}
                    <Link
                      href={`/sites/${site.id}/emergency${env.kind === "STAGING" ? "?env=staging" : ""}`}
                      className="underline"
                    >
                      Emergency
                    </Link>
                    .
                  </Notice>
                )}
                {env.lastTestOk === false && env.lastTestError && (
                  <p className="rounded-md bg-destructive/5 px-2 py-1.5 text-sm text-destructive">
                    Last test: {env.lastTestError}
                  </p>
                )}
                <div className="flex flex-wrap items-start gap-3">
                  {manage && !site.archived && <TestConnection siteId={site.id} kind={env.kind} />}
                  {refresh && !blocked && <RefreshInventory siteId={site.id} env={env} />}
                  {refresh && !blocked && <CheckInventoryUpdates siteId={site.id} env={env} />}
                  {refresh && !blocked && <RunHealthCheck siteId={site.id} kind={env.kind} />}
                </div>
                {manage && env.hostKey && (
                  <ActionForm
                    action={resetHostKeyAction}
                    submitLabel="Reset pinned host key"
                    variant="destructive"
                    confirm={{
                      title: "Ask to reset the pinned host key?",
                      description:
                        "Only do this when the host confirms the server changed. Another Admin must approve; then the next Test connection pins whatever key the server presents.",
                    }}
                  >
                    {hidden}
                    <input type="hidden" name="kind" value={env.kind} />
                  </ActionForm>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
