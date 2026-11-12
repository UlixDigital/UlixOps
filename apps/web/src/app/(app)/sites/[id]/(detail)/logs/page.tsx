// Spec screen 5, Logs: the PHP error log (Phase 4 step 1, A159) and job logs [P1] for remote work
// on this site (output redacted by the runner).
import { can, ErrorLogView, SiteJobList } from "@ulixops/shared";
import Link from "next/link";
import { readErrorLogAction, setLoggingAction } from "@/app/(app)/monitoring/php-errors/actions";
import { ActionForm } from "@/components/action-form";
import { ErrorGroupList, LoggingBadge } from "@/components/php-errors";
import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/backups";
import { Badge } from "../parts";

export const metadata: Metadata = { title: "Logs · UlixOps" };

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const site = await loadSite((await params).id);
  const kind =
    (await searchParams).env === "staging" && site.environments.some((e) => e.kind === "STAGING")
      ? "STAGING"
      : "PRODUCTION";
  const auth = await apiAuth();
  const [res, log] = await Promise.all([
    apiGet(`/sites/${site.id}/jobs?limit=50`, SiteJobList, auth),
    apiGet(`/sites/${site.id}/php-errors?kind=${kind.toLowerCase()}`, ErrorLogView, auth),
  ]);
  const canRead = can(user.role, "sites.refresh") && !site.archived;
  const canSwitch = can(user.role, "sites.manage") && !site.archived;

  return (
    <div className="grid min-w-0 gap-4">
      <Card className="min-w-0">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 flex-1 basis-72 gap-1.5">
            <CardTitle className="text-base">PHP error log</CardTitle>
            <CardDescription>
              End of the UlixOps private PHP error log (or debug.log if that is all there is),
              grouped: newest serious errors first. Production is read every 6 hours; a new fatal
              error sends an alert.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {site.environments.length > 1 &&
              site.environments.map((e) => (
                <Link
                  key={e.kind}
                  href={`/sites/${site.id}/logs${e.kind === "STAGING" ? "?env=staging" : ""}`}
                  aria-current={e.kind === kind ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
                    e.kind === kind
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {ENV_LABELS[e.kind]}
                </Link>
              ))}
            {canRead && (
              <ActionForm
                action={readErrorLogAction}
                submitLabel="Read now"
                variant="outline"
                pendingLabel="Reading the log…"
              >
                <input type="hidden" name="siteId" value={site.id} />
                <input type="hidden" name="kind" value={kind} />
              </ActionForm>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3">
          {log.ok && log.data.readAt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <LoggingBadge logging={log.data.logging} />
              {canSwitch && log.data.logging.state === "off" && !log.data.logging.managed && (
                <ActionForm
                  action={setLoggingAction}
                  submitLabel="Switch logging on"
                  variant="outline"
                  pendingLabel="Installing…"
                  confirm={{
                    title: `Switch PHP error logging on for ${site.name} (${ENV_LABELS[kind].toLowerCase()})?`,
                    description:
                      "UlixOps installs a must-use plugin that writes PHP errors to a private PHP file (wp-content/ulixops-logs/php-errors.php) which exits if opened in a browser — so nginx hosts like WP Engine can't serve the log. Never shown on pages, never edits wp-config.php. If the file is still downloadable, the plugin is removed again. The log is kept under 10 MB.",
                  }}
                >
                  <input type="hidden" name="siteId" value={site.id} />
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="enabled" value="true" />
                </ActionForm>
              )}
              {canSwitch && log.data.logging.managed && log.data.logging.state !== "off" && (
                <ActionForm
                  action={setLoggingAction}
                  submitLabel="Switch logging off"
                  variant="outline"
                  pendingLabel="Removing…"
                  confirm={{
                    title: "Switch PHP error logging off?",
                    description:
                      "Removes the UlixOps must-use plugin. The private log file stays on the server for history.",
                  }}
                >
                  <input type="hidden" name="siteId" value={site.id} />
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="enabled" value="false" />
                </ActionForm>
              )}
            </div>
          )}
          {!log.ok ? (
            <Notice tone="error">The error log couldn&apos;t be loaded. Refresh the page.</Notice>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {log.data.readAt ? (
                  <>
                    Read <span title={formatUtc(log.data.readAt)}>{timeAgo(log.data.readAt)}</span>
                    {log.data.fileFound &&
                      ` · ${formatBytes(log.data.sizeBytes)}${log.data.truncated ? " (only the last 512 KB read)" : ""}`}
                    {log.data.fileFound &&
                      ` · ${log.data.fatal24h} fatal, ${log.data.errors24h} errors, ${log.data.warnings24h} warnings in the last 24 hours`}
                  </>
                ) : (
                  "Not read yet."
                )}
              </p>
              {log.data.ok === false && (
                <Notice tone="error">The last reading failed: {log.data.detail}</Notice>
              )}
              {log.data.readAt && !log.data.fileFound && log.data.ok !== false ? (
                <p className="text-sm text-muted-foreground">
                  No PHP error log on this site yet. Use Switch logging on to install the UlixOps
                  must-use plugin (private log under wp-content/ulixops-logs/).
                </p>
              ) : log.data.groups.length > 0 ? (
                <ErrorGroupList groups={log.data.groups} />
              ) : (
                log.data.readAt &&
                log.data.fileFound && (
                  <p className="text-sm text-muted-foreground">The log has no PHP messages.</p>
                )
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job log</CardTitle>
          <CardDescription>
            The last 50 commands UlixOps ran on this site, newest first, with their output. Secrets
            are removed before output leaves the runner.
          </CardDescription>
        </CardHeader>
      </Card>
      {!res.ok ? (
        <Notice tone="error">The job log couldn&apos;t be loaded. Refresh the page.</Notice>
      ) : res.data.jobs.length === 0 ? (
        <p className="rounded-lg border px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing has run on this site yet. Inventory refreshes and emergency actions appear here.
        </p>
      ) : (
        <ol className="grid gap-2">
          {res.data.jobs.map((job) => {
            const state = job.interrupted
              ? { label: "Interrupted", tone: "warning" as const }
              : job.status === "SUCCEEDED"
                ? { label: "Succeeded", tone: "success" as const }
                : job.status === "FAILED"
                  ? { label: "Failed", tone: "error" as const }
                  : { label: "Running", tone: "muted" as const };
            return (
              <li key={job.id} className="rounded-lg border">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className="font-medium">{job.summary}</span>
                    <span className="text-muted-foreground">{ENV_LABELS[job.kind]}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      <span title={formatUtc(job.startedAt)}>{timeAgo(job.startedAt)}</span>
                      {job.requestedBy && ` · ${job.requestedBy.email}`}
                      {job.durationMs !== null && ` · ${(job.durationMs / 1000).toFixed(1)} s`}
                      {job.exitCode !== null && ` · exit ${job.exitCode}`}
                    </span>
                  </summary>
                  <pre className="max-h-96 overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {job.output || "(no output)"}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
