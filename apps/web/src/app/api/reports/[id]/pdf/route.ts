// Authenticated PDF download proxy (A164).
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { INTERNAL_API_URL } from "@/lib/api";
import { COOKIES } from "@/lib/auth";
import { clientIpFrom } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return new NextResponse(null, { status: 404 });
  const token = (await cookies()).get(COOKIES.session)?.value;
  if (!token) return new NextResponse(null, { status: 401 });
  const res = await fetch(new URL(`/reports/${id}/pdf`, INTERNAL_API_URL), {
    headers: {
      authorization: `Bearer ${token}`,
      "x-ulix-client-ip": clientIpFrom(await headers()),
    },
    cache: "no-store",
  });
  if (!res.ok) return new NextResponse(null, { status: res.status === 401 ? 401 : 404 });
  const buf = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get("content-disposition") ?? 'attachment; filename="report.pdf"';
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
    },
  });
}
