import { can } from "@ulixops/shared";
import { type NextRequest, NextResponse } from "next/server";
import { INTERNAL_API_URL } from "@/lib/api";
import { apiAuth, readSession } from "@/lib/auth";

const FILTERS = ["action", "email", "result", "from", "to"];

/** Streams the CSV from the internal API to the browser (which cannot reach the API itself). */
export async function GET(request: NextRequest) {
  const state = await readSession();
  if (state.status !== "valid") return NextResponse.redirect(new URL("/login", request.url));
  if (!can(state.session.user.role, "audit.view")) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const query = new URLSearchParams();
  for (const key of FILTERS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const auth = await apiAuth();
  const res = await fetch(new URL(`/audit/export?${query}`, INTERNAL_API_URL), {
    headers: { authorization: `Bearer ${auth.sessionToken}`, "x-ulix-client-ip": auth.ip },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return new NextResponse("Export failed", { status: res.status });
  return new NextResponse(res.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": res.headers.get("content-disposition") ?? "attachment",
      "cache-control": "no-store",
    },
  });
}
