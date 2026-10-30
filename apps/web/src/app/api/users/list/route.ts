// Fresh users list for Settings → Users (A125). Avoids soft-nav/CDN stale RSC payloads.
import { can, UserList } from "@ulixops/shared";
import { NextResponse } from "next/server";
import { apiGet } from "@/lib/api";
import { apiAuth, readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await readSession();
  if (session.status !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(session.session.user.role, "users.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const res = await apiGet("/users", UserList, await apiAuth(), { timeoutMs: 15_000 });
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
