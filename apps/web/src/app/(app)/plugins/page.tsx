// Spec screen 6: Ulix Digital's custom plugins, their latest version, and how many production
// sites run it (from each site's last inventory, Build Order step 6).
import { can, PluginList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { RegistryTable } from "./registry-table";

export const metadata: Metadata = { title: "Plugins · UlixOps" };

export default async function PluginsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "plugins.view"))
    return <NoAccess role={user.role} what="the plugin registry" />;
  const res = await apiGet("/plugins", PluginList, await apiAuth());
  const upload = can(user.role, "plugins.upload");

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
          <p className="text-sm text-muted-foreground">
            Ulix Digital&apos;s custom plugins. Site counts are production sites, from each
            site&apos;s last inventory.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/plugins/scheduled" className={buttonVariants({ variant: "outline" })}>
            Scheduled updates
          </Link>
          {upload && (
            <Link href="/plugins/upload" className={buttonVariants()}>
              Upload plugin version
            </Link>
          )}
        </div>
      </div>
      {!res.ok ? (
        <Notice tone="error">The registry couldn&apos;t be loaded. Refresh the page.</Notice>
      ) : res.data.plugins.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-lg border px-3 py-10 text-center text-sm">
          <p className="font-medium">No custom plugins yet</p>
          <p className="max-w-md text-muted-foreground">
            Upload a plugin ZIP to start the registry. UlixOps checks the archive, records its
            checksum and tracks which sites run each version.
          </p>
          {upload && (
            <Link href="/plugins/upload" className={buttonVariants({ variant: "outline" })}>
              Upload the first plugin
            </Link>
          )}
        </div>
      ) : (
        <RegistryTable plugins={res.data.plugins} />
      )}
    </div>
  );
}
