// Spec screen 5, Logs: job logs [P1] for remote work on this site (output redacted by the
// runner). The PHP error log viewer is Phase 4.
import { SiteJobList } from "@ulixops/shared";
import type { Metadata } from "next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { Badge } from "../parts";

export const metadata: Metadata = { title: "Logs · UlixOps" };

export default async function LogsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const site = await loadSite((await params).id);
  const res = await apiGet(`/sites/${site.id}/jobs?limit=50`, SiteJobList, await apiAuth());

  return (
    <div className="grid gap-4">
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
                  <pre className="max-h-96 overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                    {job.output || "(no output)"}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">PHP error log</CardTitle>
          <CardDescription>
            Coming soon: the central PHP error log viewer is Phase 4.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
