// Backups → Full backups (Phase 2 step 5, A145): Google Drive connection, weekly schedule, the
// backup in progress, every site's copy on Drive, history, and how to restore.
import {
  can,
  FullBackupList,
  FullBackupOverview,
  type FullBackupStatus,
  WEEKDAYS,
} from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { ActionForm } from "@/components/action-form";
import { BackupProgress } from "@/components/backup-badge";
import { EnvBadge } from "@/components/env-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatBytes } from "@/lib/backups";
import { formatUtc, timeAgo } from "@/lib/format";
import { hourLabel } from "@/lib/malware";
import { cn } from "@/lib/utils";
import { BackupsTabs } from "../backups-tabs";
import { cancelBackupAction } from "./actions";
import { BackupHistoryTable } from "./history-table";
import { BackupScheduleForm } from "./schedule-form";
import { BackupSitesTable } from "./sites-table";

export const metadata: Metadata = { title: "Full backups · UlixOps" };

const FILTERS: { label: string; status: FullBackupStatus | null }[] = [
  { label: "All", status: null },
  { label: "On Drive", status: "READY" },
  { label: "Failed", status: "FAILED" },
  { label: "Skipped", status: "SKIPPED" },
  { label: "Replaced", status: "REMOVED" },
  { label: "Stopped", status: "CANCELLED" },
];

function StopButton({ id, running, site }: { id: string; running: boolean; site: string }) {
  return (
    <ActionForm
      action={cancelBackupAction}
      submitLabel={running ? "Stop backup" : "Remove from queue"}
      variant="destructive"
      confirm={
        running
          ? {
              title: `Stop the backup of ${site}?`,
              description:
                "The upload ends now and nothing is saved. Last week's backup stays on Drive.",
            }
          : undefined
      }
    >
      <input type="hidden" name="backupId" value={id} />
      <input type="hidden" name="running" value={running ? "true" : "false"} />
    </ActionForm>
  );
}

export default async function FullBackupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const raw = (await searchParams).status;
  const status = FILTERS.find((f) => f.status === raw)?.status ?? null;
  const auth = await apiAuth();
  const [overview, history] = await Promise.all([
    apiGet("/full-backups/overview", FullBackupOverview, auth, { timeoutMs: 30_000 }),
    apiGet(`/full-backups?limit=100${status ? `&status=${status}` : ""}`, FullBackupList, auth),
  ]);
  const canRun = can(user.role, "sites.refresh");
  const canManage = can(user.role, "settings.manage");
  const canRestore = can(user.role, "backups.restore");
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Backups & snapshots</h1>
        <p className="text-sm text-muted-foreground">
          Weekly encrypted backups of each site&apos;s database and all files, kept on Google Drive.
          One copy per site: the new one replaces last week&apos;s once it&apos;s verified.
        </p>
      </div>
      <BackupsTabs active="/backups/full" />
    </>
  );
  if (!overview.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">Full backups couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { drive, running, queue, schedule, sites, stats } = overview.data;
  // A147: sites that failed their last health check would only be skipped, so set them aside.
  const healthy = sites.filter((s) => s.health?.ok !== false);
  const unhealthy = sites.filter((s) => s.health?.ok === false);
  const driveReady = drive.connected && drive.setup.key;
  const quota = drive.limit
    ? Math.min(100, Math.round(((drive.usage ?? 0) / drive.limit) * 100))
    : null;
  const tiles = [
    { label: "Sites backed up", value: String(stats.protected), tone: "" },
    {
      label: "Last attempt had a problem",
      value: String(stats.problems),
      tone: stats.problems ? "text-destructive" : "",
    },
    { label: "Not backed up yet", value: String(stats.never), tone: "" },
    { label: "Backups on Drive", value: formatBytes(stats.totalBytes), tone: "" },
  ];

  return (
    <div className="grid gap-4">
      {(running || queue.length > 0) && <LiveRefresh intervalMs={3_000} />}
      {header}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Drive</CardTitle>
          <CardDescription>
            {drive.connected
              ? `Connected to ${drive.email ?? "Google Drive"}${drive.connectedAt ? ` (since ${formatUtc(drive.connectedAt)})` : ""}. Backups go to the folder “UlixOps Backups”, one subfolder per site.`
              : "Not connected yet. An Admin sets it up once under Settings → Google Drive (about 10 minutes)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {drive.connected && quota !== null && (
            <div className="grid gap-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Drive storage used</span>
                <span>
                  {formatBytes(drive.usage)} of {formatBytes(drive.limit)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    quota > 90 ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${quota}%` }}
                />
              </div>
            </div>
          )}
          {!drive.connected && drive.error && <Notice>{drive.error}</Notice>}
          {drive.connected && !drive.setup.key && (
            <Notice tone="error">
              No backup encryption key yet: backups can&apos;t run. Add it in{" "}
              <Link href="/settings/google-drive" className="underline">
                Settings → Google Drive
              </Link>
              .
            </Notice>
          )}
          {canManage && (
            <p className="text-sm">
              <Link href="/settings/google-drive" className="text-link hover:underline">
                {drive.connected ? "Manage the Google Drive connection" : "Set up Google Drive"}
              </Link>{" "}
              in Settings → Google Drive.
            </p>
          )}
        </CardContent>
      </Card>

      <section aria-label="Backup summary" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tracking-tight", t.tone)}>{t.value}</p>
          </Card>
        ))}
        <Card className="col-span-2 p-4 md:col-span-1">
          <p className="text-xs text-muted-foreground">Last backup finished</p>
          <p className="mt-1 text-sm font-medium" title={formatUtc(stats.lastFinishedAt)}>
            {stats.lastFinishedAt ? timeAgo(stats.lastFinishedAt) : "—"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {schedule.enabled
              ? `Weekly: ${WEEKDAYS[schedule.dayOfWeek]} ${hourLabel(schedule.startHourUtc)} UTC`
              : "Weekly backups are off"}
          </p>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Now backing up</CardTitle>
          <CardDescription>
            One site at a time; the rest wait and start on their own.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {running ? (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{running.siteName}</span>
                  <EnvBadge kind={running.environment} />
                  <span className="text-muted-foreground">
                    {running.requestedBy ? `started by ${running.requestedBy}` : "weekly backup"}
                  </span>
                </span>
                {canRun && <StopButton id={running.id} running site={running.siteName} />}
              </div>
              <BackupProgress backup={running} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing is being backed up right now.</p>
          )}
          {queue.length > 0 && (
            <ol className="divide-y rounded-md border text-sm">
              {queue.map((b, i) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                    {b.siteName}
                    <EnvBadge kind={b.environment} />
                    <span className="text-xs text-muted-foreground">
                      queued {timeAgo(b.queuedAt)}
                    </span>
                  </span>
                  {canRun && <StopButton id={b.id} running={false} site={b.siteName} />}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule</CardTitle>
          <CardDescription>
            {schedule.enabled
              ? `Every ${WEEKDAYS[schedule.dayOfWeek]} from ${hourLabel(schedule.startHourUtc)} UTC (new backups start for ${schedule.windowHours} hours), ${schedule.includeStaging ? "production and staging" : "production only"}. Health check first; last week's copy is removed only after the new one is verified.`
              : "Weekly backups are off. Use Back up now in the table."}
          </CardDescription>
        </CardHeader>
        {canManage && (
          <CardContent>
            <BackupScheduleForm value={schedule} />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            Sites that passed their last health check. Problems and sites without a backup first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <BackupSitesTable
            rows={healthy}
            canRun={canRun}
            canManage={canManage}
            canRestore={canRestore}
            driveReady={driveReady}
          />
          {unhealthy.length > 0 && (
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {unhealthy.length} unhealthy site{unhealthy.length === 1 ? "" : "s"} hidden
              </summary>
              <p className="mt-2 text-muted-foreground">
                These failed their last health check, so a backup would be skipped (a broken site
                never replaces a good copy). Fix the site, then run a health check on its page; it
                comes back here once it passes. Weekly backups still check them every week.
              </p>
              <ul className="mt-2 divide-y">
                {unhealthy.map((s) => (
                  <li
                    key={`${s.siteId}-${s.environment}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                  >
                    <Link href={`/sites/${s.siteId}`} className="font-medium hover:underline">
                      {s.siteName}
                    </Link>
                    {s.environment === "STAGING" && <EnvBadge kind="STAGING" />}
                    <span className="text-xs text-muted-foreground">
                      {s.health?.summary ?? "Unhealthy"}
                      {s.health && ` · ${timeAgo(s.health.at)}`}
                      {s.current && ` · last copy on Drive ${timeAgo(s.current.at)}`}
                    </span>
                    {canRestore && s.current && (
                      <Link
                        href={`/backups/restore?backup=${s.current.id}`}
                        className="text-xs text-link hover:underline"
                      >
                        Restore from it
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">History</CardTitle>
          <nav aria-label="Filter backups" className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.label}
                href={f.status ? `/backups/full?status=${f.status}` : "/backups/full"}
                aria-current={f.status === status ? "page" : undefined}
                className={cn(
                  "rounded-md px-2 py-1 text-xs transition-colors duration-150",
                  f.status === status
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent>
          {history.ok ? (
            <BackupHistoryTable backups={history.data.backups} />
          ) : (
            <Notice tone="error">History couldn&apos;t be loaded. Refresh the page.</Notice>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Restoring without the hub</CardTitle>
          <CardDescription>
            Normally use the{" "}
            <Link href="/backups/restore" className="text-link hover:underline">
              Restore
            </Link>{" "}
            tab. If the hub itself is gone, this works on any computer with Node.js and the backup
            key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
            <li>Download the site&apos;s .ulxb file from Google Drive (Open in Drive, above).</li>
            <li>
              Decrypt it with the script in the UlixOps repository:
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                BACKUP_KEY=&lt;your key&gt; node scripts/decrypt-backup.mjs site.tar.gz.ulxb
                site.tar.gz
              </pre>
            </li>
            <li>
              Unpack with <code className="font-mono text-xs">tar -xzf site.tar.gz</code>: the
              WordPress files, plus <code className="font-mono text-xs">ulixops-…sql</code> (the
              database) at the top. Import it with{" "}
              <code className="font-mono text-xs">wp db import</code>.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
