import { NotificationList } from "@ulixops/shared";
import { NextResponse } from "next/server";
import { INTERNAL_API_URL } from "@/lib/api";
import { apiAuth } from "@/lib/auth";

/**
 * Unread notifications for the top-bar bell, polled in the background. Marked passive so the
 * poll never extends the 30 min idle timeout (A158); the API still checks the session fully.
 */
export async function GET() {
  const auth = await apiAuth();
  if (!auth.sessionToken) return NextResponse.json({ error: "session_invalid" }, { status: 401 });
  try {
    const res = await fetch(new URL("/notifications?limit=8&unread=1", INTERNAL_API_URL), {
      headers: {
        authorization: `Bearer ${auth.sessionToken}`,
        "x-ulix-client-ip": auth.ip,
        "x-ulix-passive": "1",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok)
      return NextResponse.json(
        { error: "unavailable" },
        { status: res.status === 401 ? 401 : 502 },
      );
    const parsed = NotificationList.safeParse(await res.json());
    if (!parsed.success) return NextResponse.json({ error: "unavailable" }, { status: 502 });
    return NextResponse.json(parsed.data, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
