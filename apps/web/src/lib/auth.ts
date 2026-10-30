import "server-only";
import { randomBytes } from "node:crypto";
import { type AuthContext, SessionInfo, Token } from "@ulixops/shared";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { apiPost } from "./api";
import { clientIpFrom } from "./client-ip";

// __Host- cookies must be Secure, Path=/ and have no Domain: they cannot be set by subdomains.
export const COOKIES = {
  session: "__Host-ulx_session",
  challenge: "__Host-ulx_challenge",
  device: "__Host-ulx_device",
} as const;

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
} as const;
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60;

type CookieJar = Awaited<ReturnType<typeof cookies>>;

/** Deleting a __Host- cookie needs the same Secure/Path attributes it was set with. */
export function clearCookie(jar: CookieJar, name: string) {
  jar.set(name, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}

/** Who is signing in, for rate limits, alerts and the audit log. Server Actions only. */
export async function requestContext(): Promise<AuthContext> {
  const jar = await cookies();
  let deviceId = jar.get(COOKIES.device)?.value;
  if (!deviceId || !Token.safeParse(deviceId).success) {
    deviceId = randomBytes(32).toString("base64url");
    jar.set(COOKIES.device, deviceId, { ...COOKIE_OPTIONS, maxAge: DEVICE_MAX_AGE });
  }
  const h = await headers();
  return { ip: clientIpFrom(h), userAgent: (h.get("user-agent") ?? "").slice(0, 512), deviceId };
}

export type SessionState =
  | { status: "valid"; session: SessionInfo }
  | { status: "expired"; reason: "idle" | "expired" }
  | { status: "none" };

/** Checks the session cookie with the API (once per request). */
export const readSession = cache(async (): Promise<SessionState> => {
  const token = (await cookies()).get(COOKIES.session)?.value;
  if (!token || !Token.safeParse(token).success) return { status: "none" };
  const res = await apiPost("/auth/session", { sessionToken: token }, SessionInfo);
  if (res.ok) return { status: "valid", session: res.data };
  if (res.error === "session_expired_idle") return { status: "expired", reason: "idle" };
  if (res.error === "session_expired_absolute") return { status: "expired", reason: "expired" };
  return { status: "none" };
});

export async function requireSession(): Promise<SessionInfo> {
  const state = await readSession();
  if (state.status === "valid") return state.session;
  redirect(state.status === "expired" ? `/login?reason=${state.reason}` : "/login");
}

export async function challengeToken(): Promise<string | undefined> {
  const value = (await cookies()).get(COOKIES.challenge)?.value;
  return value && Token.safeParse(value).success ? value : undefined;
}

/** Credentials for API calls made on behalf of the signed-in user (server components). */
export async function apiAuth(): Promise<{ sessionToken: string; ip: string }> {
  const sessionToken = (await cookies()).get(COOKIES.session)?.value ?? "";
  return { sessionToken, ip: clientIpFrom(await headers()) };
}
