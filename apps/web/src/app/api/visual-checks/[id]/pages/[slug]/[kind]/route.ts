// Authenticated proxy for visual-check PNGs (A163). Session cookie → Bearer to the API.
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { INTERNAL_API_URL } from "@/lib/api";
import { COOKIES } from "@/lib/auth";
import { clientIpFrom } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; slug: string; kind: string }> },
) {
  const { id, slug, kind } = await ctx.params;
  if (
    !/^[a-z0-9]{1,64}$/i.test(id) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(slug) ||
    !["before", "after", "diff"].includes(kind)
  ) {
    return new NextResponse(null, { status: 404 });
  }
  const token = (await cookies()).get(COOKIES.session)?.value;
  if (!token) return new NextResponse(null, { status: 401 });
  const res = await fetch(new URL(`/visual-checks/${id}/pages/${slug}/${kind}`, INTERNAL_API_URL), {
    headers: {
      authorization: `Bearer ${token}`,
      "x-ulix-client-ip": clientIpFrom(await headers()),
    },
    cache: "no-store",
  });
  if (!res.ok) return new NextResponse(null, { status: res.status === 401 ? 401 : 404 });
  const buf = Buffer.from(await res.arrayBuffer());
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
