// Spec screen 9: deploy wizard — plugin + version, sites, rollout settings, review.
import { can, PluginDetail, PluginList, RecordId, SiteList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { DeployWizard } from "./wizard";

export const metadata: Metadata = { title: "New deployment · UlixOps" };

export default async function NewDeploymentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const canStart = can(user.role, "deploy.single") || can(user.role, "deploy.bulk.request");
  if (!canStart) return <NoAccess role={user.role} what="starting deployments" />;

  const params = await searchParams;
  const pluginSlug = typeof params.plugin === "string" ? params.plugin : "";
  const version = typeof params.version === "string" ? params.version : "";
  const outdatedOnly = params.outdated === "1";
  /** From a site's Deployments tab: start with that site picked. */
  const siteParam = RecordId.safeParse(params.site);

  const auth = await apiAuth();
  const [plugins, sites] = await Promise.all([
    apiGet("/plugins", PluginList, auth),
    apiGet("/sites", SiteList, auth),
  ]);
  if (!plugins.ok || !sites.ok)
    return <Notice tone="error">Couldn&apos;t load plugins or sites. Refresh the page.</Notice>;

  let preselectedSiteIds: string[] = [];
  let detailVersions: { version: string; changelog: string }[] = [];
  if (pluginSlug && /^[a-z0-9][a-z0-9-]{0,99}$/.test(pluginSlug)) {
    const detail = await apiGet(`/plugins/${pluginSlug}`, PluginDetail, auth);
    if (detail.ok) {
      detailVersions = detail.data.versions.map((v) => ({
        version: v.version,
        changelog: v.changelog,
      }));
      if (outdatedOnly) {
        preselectedSiteIds = detail.data.sites
          .filter((s) => s.kind === "PRODUCTION" && s.status === "outdated")
          .map((s) => s.siteId);
      }
    }
  }

  if (siteParam.success && sites.data.sites.some((s) => s.id === siteParam.data))
    preselectedSiteIds = [...new Set([...preselectedSiteIds, siteParam.data])];

  const siteOptions = sites.data.sites.map((s) => {
    const prod = s.environments.find((e) => e.kind === "PRODUCTION");
    const staging = s.environments.find((e) => e.kind === "STAGING");
    return {
      id: s.id,
      name: s.name,
      url: prod?.url ?? "",
      tags: s.tags,
      host: s.host,
      productionPinned: Boolean(prod?.hostKey),
      hasStaging: Boolean(staging),
      stagingPinned: Boolean(staging?.hostKey),
    };
  });

  return (
    <div className="grid max-w-3xl gap-4">
      <Link href="/deployments" className="text-sm text-muted-foreground hover:text-foreground">
        ← Deployments
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Deploy wizard</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plugin version and sites. Two or more production sites need a second Admin to
          approve before the rollout starts.
        </p>
      </div>
      <DeployWizard
        plugins={plugins.data.plugins.map((p) => ({
          slug: p.slug,
          name: p.name,
          latestVersion: p.latestVersion,
        }))}
        siteOptions={siteOptions}
        initialPlugin={pluginSlug}
        initialVersion={version || undefined}
        initialSiteIds={preselectedSiteIds}
        versionsForPlugin={detailVersions}
      />
    </div>
  );
}
