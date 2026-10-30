"use server";
// Form handlers. Next.js checks the Origin of every Server Action call, and the session cookies
// are SameSite=Strict: together, the CSRF protection (agent decision A28).
import {
  AuthenticationCredential,
  type AuthErrorCode,
  ChallengeResponse,
  PASSWORD_MIN,
  SessionResponse,
} from "@ulixops/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiPost } from "@/lib/api";
import { COOKIE_OPTIONS, COOKIES, challengeToken, clearCookie, requestContext } from "@/lib/auth";

export interface FormState {
  error?: string;
}

const MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  invalid_credentials: "Email or password is incorrect.",
  invalid_code:
    "That code didn't work. Enter the current 6-digit code from your authenticator app.",
  rate_limited: "Too many attempts. Wait 15 minutes, then try again.",
  weak_password: `Use at least ${PASSWORD_MIN} characters, and not your email address.`,
  setup_invalid: "This setup link is invalid or has already been used. Ask an Admin for a new one.",
};

function message(error: AuthErrorCode): string {
  return MESSAGES[error] ?? "Something went wrong. Try again.";
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function saveChallenge(challenge: ChallengeResponse): Promise<never> {
  (await cookies()).set(COOKIES.challenge, challenge.challengeToken, {
    ...COOKIE_OPTIONS,
    expires: new Date(challenge.expiresAt),
  });
  redirect(challenge.next === "totp" ? "/login/verify" : "/setup/2fa");
}

async function startSession(session: SessionResponse): Promise<never> {
  const jar = await cookies();
  jar.set(COOKIES.session, session.sessionToken, {
    ...COOKIE_OPTIONS,
    expires: new Date(session.expiresAt),
  });
  clearCookie(jar, COOKIES.challenge);
  redirect("/");
}

async function challengeExpired(): Promise<never> {
  clearCookie(await cookies(), COOKIES.challenge);
  redirect("/login?reason=challenge");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const res = await apiPost(
    "/auth/login",
    {
      email: field(form, "email"),
      password: field(form, "password"),
      context: await requestContext(),
    },
    ChallengeResponse,
  );
  if (!res.ok) return { error: message(res.error) };
  return saveChallenge(res.data);
}

async function submitCode(path: string, form: FormData): Promise<FormState> {
  const token = await challengeToken();
  if (!token) return challengeExpired();
  const res = await apiPost(
    path,
    {
      challengeToken: token,
      code: field(form, "code").replace(/\s/g, ""),
      context: await requestContext(),
    },
    SessionResponse,
  );
  if (!res.ok)
    return res.error === "challenge_expired" ? challengeExpired() : { error: message(res.error) };
  return startSession(res.data);
}

export async function verifyCodeAction(_prev: FormState, form: FormData): Promise<FormState> {
  return submitCode("/auth/login/totp", form);
}

export async function confirmEnrollmentAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  return submitCode("/auth/2fa/enroll/confirm", form);
}

/** Second factor with a passkey; the credential comes from the browser's WebAuthn prompt. */
export async function passkeyLoginAction(credential: unknown): Promise<FormState> {
  const token = await challengeToken();
  if (!token) return challengeExpired();
  const parsed = AuthenticationCredential.safeParse(credential);
  if (!parsed.success) return { error: "That passkey response wasn't valid. Try again." };
  const res = await apiPost(
    "/auth/login/passkey",
    { challengeToken: token, credential: parsed.data, context: await requestContext() },
    SessionResponse,
  );
  if (!res.ok) {
    if (res.error === "challenge_expired") return challengeExpired();
    return {
      error:
        res.error === "invalid_code"
          ? "That passkey didn't work. Try again, or enter the code from your authenticator app."
          : message(res.error),
    };
  }
  return startSession(res.data);
}

export async function setPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const password = field(form, "password");
  if (password !== field(form, "confirm")) return { error: "The two passwords don't match." };
  const res = await apiPost(
    "/auth/setup/password",
    { setupToken: field(form, "token"), password, context: await requestContext() },
    ChallengeResponse,
  );
  if (!res.ok) return { error: message(res.error) };
  return saveChallenge(res.data);
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const sessionToken = jar.get(COOKIES.session)?.value;
  if (sessionToken) {
    await apiPost(
      "/auth/logout",
      { sessionToken, context: await requestContext() },
      z.object({ ok: z.literal(true) }),
    ).catch(() => null);
  }
  clearCookie(jar, COOKIES.session);
  redirect("/login?reason=signed_out");
}
