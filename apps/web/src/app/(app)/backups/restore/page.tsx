// Backups → Restore (A152): put a site back from its Google Drive backup, with a second Admin's
// approval and a safety copy first; and every restore with its progress and result.
import {
  can,
  RecordId,
  RESTORE_SCOPE_LABELS,
  RestoreOverview,
  type RestoreView,
} from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { ActionForm } from "@/components/action-form";
import { EnvBadge } from "@/components/env-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { RESTORE_PHASE, RESTORE_STATUS } from "@/lib/backups";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackupsTabs } from "../backups-tabs";
import { cancelRestoreAction } from "./actions";
import { RestoreForm } from "./restore-form";

export const metadata: Metadata = { title: "Restore · UlixOps" };

function StatusBadge({ status }: { status: RestoreView["status"] }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        RESTORE_STATUS[status].tone,
      )}
    >
      {RESTORE_STATUS[status].label}
    </span>
  );
}

function Progress({ restore }: { restore: RestoreView }) {
  const phase = restore.phase ?? "checking";
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{RESTORE_PHASE[phase]}…</span>
        <span className="font-mono tabular-nums">{restore.progress}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Restore of ${restore.siteName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={restore.progress}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${Math.max(2, restore.progress)}%` }}
        />
      </div>
    </div>
  );
}

function RestoreItem({ r, canRestore }: { r: RestoreView; canRestore: boolean }) {
  const across = r.sourceEnvironment !== r.environment;
  const kind = r.source.purpose === "SAFETY" ? "safety copy" : "weekly backup";
  const when = formatUtc(r.source.at);
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <Link href={`/sites/${r.siteId}`} className="font-medium hover:underline">
            {r.siteName}
          </Link>
          {across ? (
            <span className="inline-flex items-center gap-1">
              <EnvBadge kind={r.sourceEnvironment} />
              <span className="text-xs text-muted-foreground" aria-hidden>
                →
              </span>
              <EnvBadge kind={r.environment} />
              <span className="sr-only">
                {r.sourceEnvironment === "STAGING" ? "Staging" : "Production"} to{" "}
                {r.environment === "STAGING" ? "Staging" : "Production"}
              </span>
            </span>
          ) : (
            <EnvBadge kind={r.environment} />
          )}
          <span className="text-sm text-muted-foreground">
            {RESTORE_SCOPE_LABELS[r.scope]} from the {kind} of {when}
            {across ? "" : ` onto ${r.environment === "STAGING" ? "staging" : "production"}`}
          </span>
        </span>
        <StatusBadge status={r.status} />
      </div>
      {r.status === "RUNNING" && <Progress restore={r} />}
      {r.detail && <p className="text-sm">{r.detail}</p>}
      {r.health && (
        <p className={cn("text-sm", r.health.ok ? "text-success" : "text-destructive")}>
          {r.health.ok
            ? "Health check afterwards: the site works."
            : `Health check afterwards failed: ${r.health.summary ?? "unknown"}.`}
        </p>
      )}
      {r.safety?.status === "READY" && (
        <p className="text-xs text-muted-foreground">
          Safety copy of the site before this restore
          {r.safety.expiresAt ? `, kept until ${formatUtc(r.safety.expiresAt)}` : ""}.{" "}
          {r.safety.webViewLink && (
            <a
              href={r.safety.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:underline"
            >
              Open in Drive
            </a>
          )}
          {canRestore && (
            <>
              {" · "}
              <Link
                href={`/backups/restore?backup=${r.safety.backupId}`}
                className="text-link hover:underline"
              >
                Undo: restore the safety copy
              </Link>
            </>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Requested by {r.requestedBy ?? "removed user"}{" "}
          <span title={formatUtc(r.createdAt)}>{timeAgo(r.createdAt)}</span>
          {r.approvedBy ? ` · approved by ${r.approvedBy}` : ""}
          {r.finishedAt ? ` · finished ${timeAgo(r.finishedAt)}` : ""}
        </p>
        {canRestore && (r.status === "PENDING_APPROVAL" || r.status === "QUEUED") && (
          <ActionForm action={cancelRestoreAction} submitLabel="Cancel restore" variant="outline">
            <input type="hidden" name="restoreId" value={r.id} />
          </ActionForm>
        )}
      </div>
    </li>
  );
}

export default async function RestorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const pre = RecordId.safeParse((await searchParams).backup);
  const res = await apiGet("/full-backups/restores", RestoreOverview, await apiAuth(), {
    timeoutMs: 20_000,
  });
  const canRestore = can(user.role, "backups.restore");
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Backups</h1>
        <p className="text-sm text-muted-foreground">
          Put a site back the way it was in one of its Google Drive backups. A second Admin approves
          first, and a safety copy of the site as it is now is saved before anything is overwritten.
        </p>
      </div>
      <BackupsTabs active="/backups/restore" />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">Restores couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { sources, restores, driveConnected } = res.data;
  const active = restores.some((r) => r.status === "RUNNING" || r.status === "QUEUED");

  return (
    <div className="grid gap-4">
      {active && <LiveRefresh intervalMs={3_000} />}
      {header}

      {canRestore && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restore a site</CardTitle>
            <CardDescription>
              The backup streams from Google Drive straight into the site; it&apos;s never stored on
              the hub. Visitors see the maintenance page meanwhile. A large site takes a while: the
              safety copy first, then the restore.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!driveConnected ? (
              <Notice>
                Google Drive isn&apos;t connected. Connect it on{" "}
                <Link href="/backups/full" className="text-link hover:underline">
                  Full backups
                </Link>{" "}
                first.
              </Notice>
            ) : sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No backups on Google Drive yet. Back a site up on{" "}
                <Link href="/backups/full" className="text-link hover:underline">
                  Full backups
                </Link>{" "}
                first.
              </p>
            ) : (
              <RestoreForm
                sources={sources}
                targets={res.data.targets}
                preselect={pre.success ? pre.data : null}
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Restores</CardTitle>
          <CardDescription>
            Newest first (the last 50). A failed restore that changed the site can be undone with
            its safety copy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {restores.length === 0 ? (
            <p className="text-sm text-muted-foreground">No restores yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {restores.map((r) => (
                <RestoreItem key={r.id} r={r} canRestore={canRestore} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
