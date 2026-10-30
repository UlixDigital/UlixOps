// Spec screen 5, Emergency (spec 6.7): actions that work when wp-admin is down, because WP-CLI
// runs them without loading plugins or the theme (agent decision A54). Restore latest snapshot
// needs snapshots (Build Order step 8).
import { can, InventoryResponse } from "@ulixops/shared";
import type { Metadata } from "next";
import { useId } from "react";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { loadSite, pickEnvironment } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { rollbackLastAction, siteActionAction } from "../../../actions";
import { EnvSwitcher, remoteBlocker } from "../parts";
import { LiveMaintenanceCard } from "./live-maintenance";

export const metadata: Metadata = { title: "Emergency · UlixOps" };

function PluginField({ plugins }: { plugins: string[] }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-plugin`}>Plugin (folder name)</Label>
      <Input
        id={`${id}-plugin`}
        name="plugin"
        required
        maxLength={100}
        list={`${id}-active`}
        autoComplete="off"
        placeholder="e.g. akismet"
        className="font-mono"
      />
      <datalist id={`${id}-active`}>
        {plugins.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  );
}

export default async function EmergencyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ env?: string | string[] }>;
}) {
  const { user } = await requireSession();
  if (!can(user.role, "site.emergency"))
    return <NoAccess role={user.role} what="emergency actions" />;
  const site = await loadSite((await params).id);
  const env = pickEnvironment(site, (await searchParams).env);
  const auth = await apiAuth();
  // Inventory only on SSR so Emergency opens immediately; live SSH runs client-side (A113).
  const res = await apiGet(
    `/sites/${site.id}/environments/${env.kind.toLowerCase()}/inventory`,
    InventoryResponse,
    auth,
  );
  const inventory = res.ok ? res.data.inventory : null;
  const active = (inventory?.plugins ?? []).filter((p) => p.status === "active").map((p) => p.name);
  const blocked = remoteBlocker(site, env);
  const where = ENV_LABELS[env.kind].toLowerCase();
  const hidden = (
    <>
      <input type="hidden" name="siteId" value={site.id} />
      <input type="hidden" name="kind" value={env.kind} />
    </>
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <EnvSwitcher site={site} current={env} path="/emergency" />
        <p className="text-sm text-muted-foreground">
          These run over SSH with WP-CLI, without loading plugins or the theme, so they work even
          when the site and wp-admin are down. Every action is audited and kept under Logs.
        </p>
      </div>
      {blocked && <Notice>{blocked}</Notice>}
      {inventory?.safeMode && (
        <Notice tone="error">
          The last inventory ({timeAgo(inventory.refreshedAt)}) could only be read with plugins
          skipped: a plugin is probably crashing the site. Deactivate the plugin you changed last,
          then refresh the inventory from the Overview to check the site loads plugins again.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Deactivate a plugin</CardTitle>
            <CardDescription>
              Stops the plugin without running any plugin code, including its own deactivation hook.
              Settings stay in the database; activate it again from Plugins &amp; themes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {blocked ? null : (
              <ActionForm
                action={siteActionAction}
                submitLabel="Deactivate plugin"
                variant="destructive"
                confirm={{
                  title: `Deactivate this plugin on ${where}?`,
                  description:
                    "The site stops running it straight away. Use this when a plugin breaks the site.",
                }}
              >
                {hidden}
                <input type="hidden" name="action" value="plugin.deactivate" />
                <input type="hidden" name="emergency" value="true" />
                <PluginField plugins={active} />
                {active.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Active at the last inventory: {active.join(", ")}
                  </p>
                )}
              </ActionForm>
            )}
          </CardContent>
        </Card>

        <LiveMaintenanceCard
          siteId={site.id}
          kind={env.kind}
          where={where}
          blocked={!!blocked}
          initialOn={inventory?.maintenance ?? null}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Flush cache</CardTitle>
            <CardDescription>
              Empties the WordPress object cache (<code className="font-mono">wp cache flush</code>
              ). Page caches run by the host are separate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!blocked && (
              <ActionForm
                action={siteActionAction}
                submitLabel="Flush cache"
                variant="outline"
                confirm={{
                  title: `Flush the object cache on ${where}?`,
                  description: "Pages may load a little slower until the cache warms up again.",
                }}
              >
                {hidden}
                <input type="hidden" name="action" value="cache.flush" />
              </ActionForm>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restore latest snapshot</CardTitle>
            <CardDescription>
              Restores the most recent quick snapshot for this environment (plugin folder, and the
              database if that snapshot included one), then flushes the object cache. This is not
              necessarily the snapshot taken before the last plugin update.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!blocked && (
              <ActionForm
                action={rollbackLastAction}
                submitLabel="Restore latest snapshot"
                variant="destructive"
                confirm={{
                  title: `Restore the latest snapshot on ${where}?`,
                  description:
                    "This replaces the plugin folder (and database, if the snapshot had one) with the most recent quick snapshot for this environment. Take a new snapshot first if you need a restore point for the current state.",
                }}
              >
                {hidden}
              </ActionForm>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
