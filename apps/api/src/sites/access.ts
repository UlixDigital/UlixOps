// Tag-scoped site access for CLIENT_VIEWER (A178). Staff roles see the full fleet.
import { isClientViewer, type SessionInfo } from "@ulixops/shared";
import type { Prisma } from "../generated/prisma/client";

export type AccessUser = SessionInfo["user"];

export function siteWhereForUser(user: AccessUser): Prisma.SiteWhereInput {
  if (!isClientViewer(user.role)) return {};
  const tag = user.viewTag?.trim().toLowerCase() ?? "";
  // No tag configured → empty fleet (safe default; invite should always set a tag).
  if (!tag) return { id: "__no_view_tag__" };
  return { tags: { has: tag } };
}

/** Non-archived sites in the caller's scope (A178). */
export function activeSiteWhereForUser(user: AccessUser): Prisma.SiteWhereInput {
  return { archived: false, ...siteWhereForUser(user) };
}

export function environmentWhereForUser(user: AccessUser): Prisma.SiteEnvironmentWhereInput {
  return { site: activeSiteWhereForUser(user) };
}

/** True when this site is in the user's scope (staff always true). */
export function canAccessSite(
  user: AccessUser,
  site: { tags: string[]; archived?: boolean },
): boolean {
  if (!isClientViewer(user.role)) return true;
  const tag = user.viewTag?.trim().toLowerCase() ?? "";
  if (!tag) return false;
  if (site.archived) return false;
  return site.tags.map((t) => t.toLowerCase()).includes(tag);
}
