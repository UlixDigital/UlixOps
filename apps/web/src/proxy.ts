import { AllowlistPolicy } from "@ulixops/shared";
import { allowlistPermits, parseIpList } from "@ulixops/shared/ip";
import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";

const API_URL = process.env.API_URL || "http://localhost:4000";
const ENV_ALLOWED = parseIpList(process.env.ALLOWED_IPS);
const POLICY_TTL_MS = 15_000;
let cachedPolicy: { enabled: boolean; cidrs: string[]; fetchedAt: number } | null = null;

/** The Admin-managed allowlist, refreshed every 15 s. If the API is unreachable, the last known
 *  list keeps applying (ALLOWED_IPS always does). */
async function allowlistPolicy() {
  if (cachedPolicy && Date.now() - cachedPolicy.fetchedAt < POLICY_TTL_MS) return cachedPolicy;
  try {
    const res = await fetch(new URL("/internal/ip-allowlist", API_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok)
      cachedPolicy = { ...AllowlistPolicy.parse(await res.json()), fetchedAt: Date.now() };
  } catch {
    // keep the previous policy
  }
  return cachedPolicy ?? { enabled: false, cidrs: [], fetchedAt: 0 };
}

// 1) IP allowlist (spec section 5), before anything else is served.
// 2) Strict CSP with a fresh nonce per request. Next.js reads the nonce from the request header
//    and adds it to its own scripts, so no inline script runs without it.
export async function proxy(request: NextRequest) {
  const ip = clientIpFrom(request.headers);
  const policy = await allowlistPolicy();
  if (
    !allowlistPermits(ip, { enabled: policy.enabled, cidrs: policy.cidrs, envCidrs: ENV_ALLOWED })
  ) {
    console.warn(JSON.stringify({ event: "ip_blocked", ip, path: request.nextUrl.pathname }));
    return new NextResponse("Access to UlixOps is not allowed from this network.\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Dev mode injects styles inline for hot reload; production uses only nonce'd styles.
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // Cloudflare Tunnel can forward Server Actions without a usable Origin (logged as `null`)
  // while x-forwarded-host is the public host. Next.js then rejects the action as CSRF.
  // Only synthesize Origin for our known public host — never for arbitrary forwarded hosts.
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const origin = requestHeaders.get("origin");
  if (forwardedHost === "ulixops.ulixdigital.com" && (!origin || origin === "null")) {
    const proto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    requestHeaders.set("origin", `${proto}://${forwardedHost}`);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // Authenticated hub pages must never be cached at the edge (A125: stale 2-site Sites list).
  response.headers.set("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
  response.headers.set("CDN-Cache-Control", "no-store");
  response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  response.headers.set("Vary", "Cookie");

  // Long-lived random device id, so sign-ins from a new browser can alert admins.
  if (!request.cookies.has(DEVICE_COOKIE)) {
    response.cookies.set(DEVICE_COOKIE, randomId(), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 400 * 24 * 60 * 60,
    });
  }
  return response;
}

const DEVICE_COOKIE = "__Host-ulx_device";

/** 32 random bytes as base64url, the same format as every other UlixOps token. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
