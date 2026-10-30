// Spec screen 3: sites list. Plugin updates, vulnerabilities, backups and uptime join this
// table with the steps that collect them (6, Phase 2, 8, Phase 3); bulk actions with step 10.
import { can, SiteList } from "@ulixops/shared";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { SitesPageClient } from "./sites-page-client";

export const metadata: Metadata = { title: "Sites · UlixOps" };
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  if (!can(user.role, "sites.view")) return <NoAccess role={user.role} what="sites" />;
  const params = await searchParams;
  const archived = params.archived === "1";
  const host = typeof params.host === "string" ? params.host : "";
  const tag = typeof params.tag === "string" ? params.tag : "";

  // Seed the client with a live API read so the first paint cannot show a stale 2-site list (A125).
  const res = await apiGet(`/sites${archived ? "?archived=1" : ""}`, SiteList, await apiAuth(), {
    timeoutMs: 30_000,
  });

  return (
    <SitesPageClient
      canManage={can(user.role, "sites.manage")}
      canRefresh={can(user.role, "sites.refresh")}
      archived={archived}
      host={host}
      tag={tag}
      initialSites={res.ok ? res.data.sites : []}
      initialError={!res.ok}
    />
  );
}
