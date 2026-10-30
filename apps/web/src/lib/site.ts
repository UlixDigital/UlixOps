import "server-only";
import { type EnvironmentView, type EnvKind, SiteView } from "@ulixops/shared";
import { notFound } from "next/navigation";
import { cache } from "react";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";

/** One site per request, shared by the site layout and its tabs. */
export const loadSite = cache(async (id: string): Promise<SiteView> => {
  if (!/^[a-z0-9]{1,64}$/.test(id)) notFound();
  const res = await apiGet(`/sites/${id}`, SiteView, await apiAuth());
  if (!res.ok) notFound();
  return res.data;
});

/** The environment a tab shows: `?env=staging` when the site has one, otherwise production. */
export function pickEnvironment(
  site: SiteView,
  env: string | string[] | undefined,
): EnvironmentView {
  const wanted: EnvKind = env === "staging" ? "STAGING" : "PRODUCTION";
  const found =
    site.environments.find((e) => e.kind === wanted) ??
    site.environments.find((e) => e.kind === "PRODUCTION");
  if (!found) notFound();
  return found;
}
