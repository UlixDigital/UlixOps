// Google sends the browser here after "Sign in with Google" (A146). The session cookie is
// SameSite=Strict, so it isn't sent on this cross-site redirect: this page only checks the shape
// of Google's reply and forwards it, same-site, to /settings/google-drive/finish, where the
// session is present again. The code is single-use and bound to a PKCE verifier that never
// leaves the runner, so it is useless to anyone who sees this URL.
import { DriveAuthState, GoogleAuthCode } from "@ulixops/shared";

export const dynamic = "force-dynamic";

const page = (target: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${target}"><title>Connecting…</title><p>Connecting Google Drive… <a href="${target}">Continue</a></p>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const finish = "/settings/google-drive/finish";
  const error = q.get("error");
  if (error)
    return page(
      `${finish}?error=${encodeURIComponent(error === "access_denied" ? "denied" : "google")}`,
    );
  const code = GoogleAuthCode.safeParse(q.get("code"));
  const state = DriveAuthState.safeParse(q.get("state"));
  if (!code.success || !state.success) return page(`${finish}?error=invalid`);
  return page(
    `${finish}?state=${encodeURIComponent(state.data)}&code=${encodeURIComponent(code.data)}`,
  );
}
