// Fresh site list (A123/A125). Path is /api/sites/list so any poisoned CDN cache of
// /api/sites cannot keep serving an old 2-site payload.
import { can, SiteList } from "@ulixops/shared";
import { NextResponse } from "next/server";
import { apiGet } from "@/lib/api";
import { apiAuth, readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const session = await readSession();
  if (session.status !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(session.session.user.role, "sites.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const archived = new URL(req.url).searchParams.get("archived") === "1";
  const res = await apiGet(`/sites${archived ? "?archived=1" : ""}`, SiteList, await apiAuth(), {
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 502 });
  }
  return NextResponse.json(res.data, {
    headers: {
      "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
      pragma: "no-cache",
      vary: "Cookie",
      "cdn-cache-control": "no-store",
    },
  });
}
