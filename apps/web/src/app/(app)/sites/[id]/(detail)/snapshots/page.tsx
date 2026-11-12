// Spec screen 5 tab + screen 13 (site-scoped): quick snapshots with restore.
import { BackupList, can, isClientViewer, siteActionPermission } from "@ulixops/shared";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite, pickEnvironment } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { createSnapshotAction, restoreSnapshotAction } from "../../../actions";
import { Badge, EnvBadge, EnvSwitcher, remoteBlocker } from "../parts";

export const metadata: Metadata = { title: "Snapshots · UlixOps" };

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function SnapshotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ env?: string | string[] }>;
}) {
  const { user } = await requireSession();
  if (isClientViewer(user.role)) {
    return <NoAccess role={user.role} what="snapshots & backups" />;
  }
  const site = await loadSite((await params).id);
  const env = pickEnvironment(site, (await searchParams).env);
  const blocked = remoteBlocker(site, env);
  const res = await apiGet(
    `/sites/${site.id}/environments/${env.kind.toLowerCase()}/snapshots`,
    BackupList,
    await apiAuth(),
  );
  const canCreate = !blocked && can(user.role, siteActionPermission("snapshot.create", env.kind));
  const canRestore = !blocked && can(user.role, siteActionPermission("snapshot.restore", env.kind));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EnvSwitcher site={site} current={env} path="/snapshots" />
        <p className="text-sm text-muted-foreground">
          Quick snapshots of one plugin folder (and optional database). Full scheduled backups
          arrive in Phase 2.
        </p>
      </div>

      {blocked && <Notice>{blocked}</Notice>}
      {!res.ok && (
        <Notice tone="error">Snapshots couldn&apos;t be loaded. Refresh the page.</Notice>
      )}

      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Take a quick snapshot
              <EnvBadge kind={env.kind} />
            </CardTitle>
            <CardDescription>
              Copies the plugin folder from{" "}
              <strong className="font-medium text-foreground">
                {ENV_LABELS[env.kind].toLowerCase()}
              </strong>{" "}
              into an encrypted store. Tick the database when the change alters tables or stored
              data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={createSnapshotAction}
              submitLabel="Take snapshot"
              pendingLabel="Taking snapshot…"
              expectedMs={60_000}
              confirm={{
                title: `Snapshot a plugin on ${ENV_LABELS[env.kind].toLowerCase()}?`,
                description:
                  "The live site is only read. The snapshot is stored encrypted on the hub and expires per the retention setting.",
              }}
            >
              <input type="hidden" name="siteId" value={site.id} />
              <input type="hidden" name="kind" value={env.kind} />
              <div className="mb-3 grid max-w-sm gap-1.5">
                <Label htmlFor="snap-plugin">Plugin (folder name)</Label>
                <Input
                  id="snap-plugin"
                  name="plugin"
                  required
                  maxLength={100}
                  autoComplete="off"
                  placeholder="e.g. akismet"
                  className="font-mono"
                />
              </div>
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input type="checkbox" name="includeDb" value="true" className="size-4" />
                Include database export
              </label>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Snapshots
            <EnvBadge kind={env.kind} />
          </CardTitle>
          <CardDescription>
            {res.ok ? `${res.data.backups.length} shown` : "—"} for{" "}
            {ENV_LABELS[env.kind].toLowerCase()}. Expired snapshots are removed automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {res.ok && res.data.backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No snapshots yet for {ENV_LABELS[env.kind].toLowerCase()}.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {(res.ok ? res.data.backups : []).map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {b.pluginName ?? "Plugin"}
                      {b.pluginVersion ? (
                        <span className="font-mono text-xs font-normal text-muted-foreground">
                          {b.pluginVersion}
                        </span>
                      ) : null}
                      <EnvBadge kind={b.environment} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <span title={formatUtc(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                      {b.createdBy && ` · ${b.createdBy.email}`}
                      {b.includesDb && " · includes DB"}
                      {` · ${formatBytes(b.sizeBytes)}`}
                      {b.expiresAt && (
                        <>
                          {" · expires "}
                          <span title={formatUtc(b.expiresAt)}>{timeAgo(b.expiresAt)}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        b.status === "READY" ? "success" : b.status === "FAILED" ? "error" : "muted"
                      }
                    >
                      {b.status.toLowerCase()}
                    </Badge>
                    {canRestore && b.status === "READY" && (
                      <ActionForm
                        action={restoreSnapshotAction}
                        submitLabel="Restore"
                        variant="outline"
                        pendingLabel="Restoring…"
                        expectedMs={60_000}
                        confirm={{
                          title: `Restore ${b.pluginName} on ${ENV_LABELS[env.kind].toLowerCase()}?`,
                          description: b.includesDb
                            ? "Replaces the plugin folder and imports the database from this snapshot, then flushes the cache."
                            : "Replaces the plugin folder from this snapshot, then flushes the cache. The database is not changed.",
                        }}
                      >
                        <input type="hidden" name="siteId" value={site.id} />
                        <input type="hidden" name="kind" value={env.kind} />
                        <input type="hidden" name="backupId" value={b.id} />
                      </ActionForm>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
