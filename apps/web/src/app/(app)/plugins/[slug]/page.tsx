// Spec screen 8: a plugin's version history and which version each site runs. "Update outdated
// sites" opens the deploy wizard with the outdated production sites picked.
import { can, PluginDetail } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SitesTable } from "./sites-table";
import { STATUS } from "./status";

export const metadata: Metadata = { title: "Plugin · UlixOps" };

export default async function PluginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { user } = await requireSession();
  if (!can(user.role, "plugins.view"))
    return <NoAccess role={user.role} what="the plugin registry" />;
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) notFound();
  const res = await apiGet(`/plugins/${slug}`, PluginDetail, await apiAuth());
  if (!res.ok) notFound();
  const plugin = res.data;
  const counts = plugin.production;
  const inUse = new Map<string, number>();
  for (const row of plugin.sites)
    if (row.installedVersion)
      inUse.set(row.installedVersion, (inUse.get(row.installedVersion) ?? 0) + 1);

  return (
    <div className="grid gap-4">
      <Link href="/plugins" className="text-sm text-muted-foreground hover:text-foreground">
        ← Plugins
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{plugin.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{plugin.slug}</span> · latest{" "}
            <span className="font-mono">{plugin.latestVersion ?? "—"}</span> · {plugin.versionCount}{" "}
            version{plugin.versionCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(user.role, "plugins.upload") && (
            <Link href="/plugins/upload" className={buttonVariants({ variant: "outline" })}>
              Upload new version
            </Link>
          )}
          {(can(user.role, "deploy.single") || can(user.role, "deploy.bulk.request")) &&
            plugin.latestVersion &&
            counts.outdated > 0 && (
              <Link
                href={`/deployments/new?plugin=${encodeURIComponent(plugin.slug)}&version=${encodeURIComponent(plugin.latestVersion)}&outdated=1`}
                className={buttonVariants()}
              >
                Update outdated sites
              </Link>
            )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            Production: {counts.latest} on the latest version, {counts.outdated} outdated
            {counts.newer > 0 && `, ${counts.newer} newer than the registry`}, {counts.notInstalled}{" "}
            without it, {counts.unknown} not read yet. Read from each environment&apos;s last
            inventory; refresh a site&apos;s inventory to update it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {inUse.size > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Versions in use:</span>
              {[...inUse.entries()].map(([version, n]) => (
                <span
                  key={version}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 font-mono text-xs",
                    version === plugin.latestVersion ? STATUS.latest.tone : "bg-muted",
                  )}
                >
                  {version} × {n}
                </span>
              ))}
            </p>
          )}
          <SitesTable rows={plugin.sites} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Version history</CardTitle>
          <CardDescription>
            Highest version first. Checksums are SHA-256 of the uploaded ZIP.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {plugin.versions.map((v) => (
              <li key={v.version} className="grid gap-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{v.version}</span>
                  {v.version === plugin.latestVersion && (
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-xs font-medium",
                        STATUS.latest.tone,
                      )}
                    >
                      Latest
                    </span>
                  )}
                  {v.dbChanging && (
                    <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                      Changes the database
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatUtc(v.createdAt)}
                    {v.uploadedBy && ` · ${v.uploadedBy.email}`} · {(v.sizeBytes / 1024).toFixed(0)}{" "}
                    KB
                    {v.requiresWp && ` · WP ${v.requiresWp}+`}
                    {v.requiresPhp && ` · PHP ${v.requiresPhp}+`}
                  </span>
                </div>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  sha256 {v.sha256}
                </p>
                <p className="whitespace-pre-wrap">{v.changelog}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
