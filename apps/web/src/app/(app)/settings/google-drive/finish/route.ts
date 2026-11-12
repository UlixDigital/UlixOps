// Second hop of "Sign in with Google" (A146): same-site, so the session is here. Hands Google's
// code to the API (which seals it to the runner), then returns to Settings → Google Drive.
import { DriveAuthFinish, DriveAuthState, GoogleAuthCode } from "@ulixops/shared";
import { apiSend } from "@/lib/api";
import { apiAuth, readSession } from "@/lib/auth";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  denied: "Google sign-in was cancelled. Click Sign in with Google and choose Allow.",
  google: "Google reported a problem with the sign-in. Try again.",
  invalid: "Google's reply wasn't complete. Try again.",
};

// Relative Location: behind the tunnel req.url is the container's own address (0.0.0.0:3000),
// so an absolute redirect built from it would send the browser there.
const redirect = (path: string) => new Response(null, { status: 303, headers: { location: path } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = "/settings/google-drive";
  const session = await readSession();
  if (session.status !== "valid") return redirect("/login");

  const error = url.searchParams.get("error");
  if (error) {
    await setFlash(ERRORS[error] ?? ERRORS.google ?? "");
    return redirect(back);
  }
  const code = GoogleAuthCode.safeParse(url.searchParams.get("code"));
  const state = DriveAuthState.safeParse(url.searchParams.get("state"));
  if (!code.success || !state.success) {
    await setFlash(ERRORS.invalid ?? "");
    return redirect(back);
  }
  const res = await apiSend(
    "POST",
    "/full-backups/drive/authorize/finish",
    { state: state.data, code: code.data },
    DriveAuthFinish,
    await apiAuth(),
    { timeoutMs: 45_000 },
  );
  await setFlash(
    !res.ok
      ? "The sign-in couldn't be finished (only Admins can connect Drive). Try again."
      : res.data.status === "connected"
        ? `Google Drive connected${res.data.email ? ` as ${res.data.email}` : ""}.`
        : res.data.detail,
  );
  return redirect(back);
}
