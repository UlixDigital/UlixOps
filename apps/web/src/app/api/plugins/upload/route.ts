// Plugin ZIP check (screen 7) as a plain POST with the raw ZIP, not a Server Action (A141).
// Cloudflare's managed rule for CVE-2025-55183 ("React - Leaking Server Functions") blocks
// Server Action requests carrying a large binary body, so uploads go through this route.
import { can, MAX_PLUGIN_ZIP_BYTES, PluginUploadResult } from "@ulixops/shared";
import { NextResponse } from "next/server";
import { apiUpload } from "@/lib/api";
import { apiAuth, readSession } from "@/lib/auth";
import { errorMessage } from "@/lib/messages";

export const dynamic = "force-dynamic";

const PUBLIC_HOSTS = new Set(["ulixops.ulixdigital.com"]);

/** Same-origin only (the session cookie is SameSite=Strict too): no cross-site uploads. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = req.headers.get("x-forwarded-host");
  return host === new URL(req.url).host || host === forwarded || PUBLIC_HOSTS.has(host);
}

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const session = await readSession();
  if (session.status !== "valid") return fail(401, "Your session ended. Sign in again.");
  if (!can(session.session.user.role, "plugins.upload"))
    return fail(403, "Your role can't upload plugins.");
  if (!sameOrigin(req)) return fail(403, "Upload refused: it didn't come from this page.");
  if (req.headers.get("content-type") !== "application/zip")
    return fail(415, "Choose a plugin ZIP file.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PLUGIN_ZIP_BYTES)
    return fail(413, `The file is larger than ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024} MB.`);

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return fail(400, "Choose a plugin ZIP file.");
  if (body.length > MAX_PLUGIN_ZIP_BYTES)
    return fail(413, `The file is larger than ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024} MB.`);

  const filename = (new URL(req.url).searchParams.get("filename") ?? "plugin.zip").slice(0, 200);
  const res = await apiUpload(
    `/plugins/uploads?filename=${encodeURIComponent(filename)}`,
    body,
    "application/zip",
    PluginUploadResult,
    await apiAuth(),
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return fail(400, errorMessage(res.error));
  return NextResponse.json({ result: res.data }, { headers: { "cache-control": "no-store" } });
}
