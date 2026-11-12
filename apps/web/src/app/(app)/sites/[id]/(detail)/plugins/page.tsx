// Spec screen 5, Plugins & themes: inventory, activate / deactivate, and snapshot-first updates.
import {
  BulkUpdateStatusResponse,
  can,
  InventoryResponse,
  isClientViewer,
  siteActionPermission,
  versionJumpSafety,
  type BulkUpdatePlanItem,
} from "@ulixops/shared";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite, pickEnvironment } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { CheckInventoryUpdates, EnvSwitcher, RefreshInventory, remoteBlocker } from "../parts";
import { AutoUpdateCard } from "./auto-update-card";
import { BulkUpdateForm } from "./bulk-update-form";
import { BulkUpdateProgress } from "./bulk-update-progress";
import { CoreCard } from "./core-card";
import { PluginsTable, ThemesTable } from "./inventory-tables";

export const metadata: Metadata = { title: "Plugins & themes · UlixOps" };

export default async function PluginsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ env?: string | string[] }>;
}) {
  const { user } = await requireSession();
  if (isClientViewer(user.role)) {
    return <NoAccess role={user.role} what="plugins & themes" />;
  }
  const site = await loadSite((await params).id);
  const env = pickEnvironment(site, (await searchParams).env);
  const auth = await apiAuth();
  const res = await apiGet(
    `/sites/${site.id}/environments/${env.kind.toLowerCase()}/inventory`,
    InventoryResponse,
    auth,
  );
  const inventory = res.ok ? res.data.inventory : null;
  const blocked = remoteBlocker(site, env);
  const actions = !blocked;
  const plan: BulkUpdatePlanItem[] = [];
  if (inventory) {
    for (const p of inventory.plugins) {
      if (!p.updateVersion) continue;
      plan.push({
        asset: "plugin",
        name: p.name,
        version: p.version,
        updateVersion: p.updateVersion,
        safety: versionJumpSafety(p.version, p.updateVersion),
      });
    }
    for (const t of inventory.themes) {
      if (!t.updateVersion) continue;
      plan.push({
        asset: "theme",
        name: t.name,
        version: t.version,
        updateVersion: t.updateVersion,
        safety: versionJumpSafety(t.version, t.updateVersion),
      });
    }
  }
  const pluginUpdates = plan.filter((p) => p.asset === "plugin").length;
  const themeUpdates = plan.filter((p) => p.asset === "theme").length;
  const updates = plan.length;
  const canBulk =
    actions && can(user.role, siteActionPermission("plugin.update", env.kind)) && updates > 0;

  const statusRes = await apiGet(
    `/sites/${site.id}/environments/${env.kind.toLowerCase()}/bulk-update/status`,
    BulkUpdateStatusResponse,
    auth,
  );
  const bulkStatus = statusRes.ok ? statusRes.data : null;
  const envQuery = env.kind === "STAGING" ? "staging" : "production";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <EnvSwitcher site={site} current={env} path="/plugins" />
          <p className="text-sm text-muted-foreground">
            {inventory ? (
              <>
                {ENV_LABELS[env.kind]} inventory read{" "}
                <span title={formatUtc(inventory.refreshedAt)}>
                  {timeAgo(inventory.refreshedAt)}
                </span>
                {inventory.refreshedBy && ` by ${inventory.refreshedBy.email}`}
                {" · "}
                {inventory.updatesCheckedAt ? (
                  <span title={formatUtc(inventory.updatesCheckedAt)}>
                    updates checked {timeAgo(inventory.updatesCheckedAt)}
                  </span>
                ) : (
                  "updates not checked yet"
                )}
              </>
            ) : (
              `${ENV_LABELS[env.kind]}: no inventory yet`
            )}
          </p>
        </div>
        {can(user.role, "sites.refresh") && actions && (
          <div className="flex flex-wrap gap-2">
            <RefreshInventory siteId={site.id} env={env} />
            <CheckInventoryUpdates siteId={site.id} env={env} />
          </div>
        )}
      </div>

      {!res.ok && (
        <Notice tone="error">The inventory couldn&apos;t be loaded. Refresh the page.</Notice>
      )}
      {blocked && <Notice>{blocked}</Notice>}
      {inventory?.safeMode && (
        <Notice tone="error">
          WP-CLI crashed with plugins loaded, so this list was read with plugins and themes skipped.
          A plugin may be breaking the site: use Emergency → Deactivate a plugin.
        </Notice>
      )}
      {inventory && inventory.warnings.length > 0 && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer">
            {inventory.warnings.length} note{inventory.warnings.length === 1 ? "" : "s"} from the
            last inventory
          </summary>
          <ul className="mt-2 grid gap-1 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {inventory.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {bulkStatus && (
        <BulkUpdateProgress
          status={bulkStatus}
          siteId={site.id}
          envQuery={envQuery}
          canDismiss={can(user.role, "sites.refresh")}
        />
      )}

      <AutoUpdateCard
        siteId={site.id}
        siteName={site.name}
        installed={[
          ...(inventory?.plugins ?? [])
            .filter((p) => p.status !== "must-use" && p.status !== "dropin")
            .map((p) => ({ asset: "plugin" as const, name: p.name })),
          ...(inventory?.themes ?? []).map((t) => ({ asset: "theme" as const, name: t.name })),
        ]}
        canManage={can(user.role, "sites.manage")}
      />

      {!inventory ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No inventory yet</CardTitle>
            <CardDescription>
              Read the inventory to list this environment&apos;s plugins and themes over SSH. It
              runs read-only WP-CLI commands and takes a few seconds.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <CoreCard
            siteId={site.id}
            kind={env.kind}
            wpVersion={inventory.wpVersion}
            coreUpdateVersion={inventory.coreUpdateVersion ?? null}
            wpEngine={site.host === "WPENGINE"}
            canUpdate={actions && can(user.role, siteActionPermission("core.update", env.kind))}
          />
          {canBulk && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Update all outdated</CardTitle>
                <CardDescription>
                  {pluginUpdates} plugin{pluginUpdates === 1 ? "" : "s"}
                  {themeUpdates > 0
                    ? ` and ${themeUpdates} theme${themeUpdates === 1 ? "" : "s"}`
                    : ""}{" "}
                  on {ENV_LABELS[env.kind].toLowerCase()} have updates. Review versions before
                  submitting; production bulk waits for another Admin.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BulkUpdateForm
                  siteId={site.id}
                  kind={env.kind}
                  where={ENV_LABELS[env.kind].toLowerCase()}
                  plan={plan}
                />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Plugins</CardTitle>
              <CardDescription>
                {inventory.plugins.length} installed
                {pluginUpdates > 0 && `, ${pluginUpdates} with an update available`}. Every update
                takes a quick snapshot first so you can roll it back from Emergency.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PluginsTable
                siteId={site.id}
                kind={env.kind}
                plugins={inventory.plugins}
                canActivate={
                  actions && can(user.role, siteActionPermission("plugin.activate", env.kind))
                }
                canDeactivate={
                  actions && can(user.role, siteActionPermission("plugin.deactivate", env.kind))
                }
                canDelete={
                  actions && can(user.role, siteActionPermission("plugin.delete", env.kind))
                }
                updatesChecked={Boolean(inventory.updatesCheckedAt)}
                canUpdate={
                  actions && can(user.role, siteActionPermission("plugin.update", env.kind))
                }
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Themes</CardTitle>
              <CardDescription>
                Active theme: {inventory.activeTheme ?? "unknown"}
                {themeUpdates > 0 && `; ${themeUpdates} with an update available`}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ThemesTable
                siteId={site.id}
                kind={env.kind}
                themes={inventory.themes}
                canUpdate={
                  actions && can(user.role, siteActionPermission("theme.update", env.kind))
                }
                canDelete={
                  actions && can(user.role, siteActionPermission("theme.delete", env.kind))
                }
                updatesChecked={Boolean(inventory.updatesCheckedAt)}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
