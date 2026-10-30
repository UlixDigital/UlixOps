// Stable HTTP endpoint for Sites quick actions (A119). Client loops this one site at a time.
import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import {
  executeQuickSiteAction,
  QuickSiteActionRequest,
  quickActionAllowed,
} from "@/lib/quick-site-action";

export const maxDuration = 200;

export async function POST(req: Request) {
  const session = await readSession();
  if (session.status !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = QuickSiteActionRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!quickActionAllowed(session.session.user.role, parsed.data.action)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await executeQuickSiteAction(parsed.data);
  return NextResponse.json(result);
}
