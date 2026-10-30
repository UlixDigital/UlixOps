"use server";
import {
  Ok,
  PasskeyView,
  RecordId,
  RegistrationCredential,
  WebAuthnOptions,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth, clearCookie, COOKIES, requestContext } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function updateProfileAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = field(form, "name").slice(0, 100);
  const res = await apiSend("PATCH", "/account", { name: name || null }, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Profile saved");
  revalidatePath("/", "layout");
  return {};
}

export async function revokeOwnSessionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const sessionId = RecordId.safeParse(field(form, "sessionId"));
  if (!sessionId.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/account/sessions/${sessionId.data}/revoke`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  if (field(form, "current") === "true") {
    clearCookie(await cookies(), COOKIES.session);
    redirect("/login?reason=signed_out");
  }
  await setFlash("Session ended");
  revalidatePath("/account");
  return {};
}

export async function revokeOtherSessionsAction(_prev: ActionState): Promise<ActionState> {
  const res = await apiSend("POST", "/account/sessions/revoke-others", {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Signed out everywhere else");
  revalidatePath("/account");
  return {};
}

/** Step 1 of adding a passkey: the current authenticator code unlocks a registration prompt. */
export async function passkeyOptionsAction(
  code: string,
): Promise<{ options?: Record<string, unknown>; error?: string }> {
  const res = await apiSend(
    "POST",
    "/account/passkeys/options",
    { code: code.replace(/\s/g, ""), context: await requestContext() },
    WebAuthnOptions,
    await apiAuth(),
  );
  if (!res.ok) {
    return {
      error:
        res.error === "invalid_code"
          ? "That code didn't work. Enter the current 6-digit code from your authenticator app."
          : errorMessage(res.error),
    };
  }
  return { options: res.data };
}

export async function addPasskeyAction(
  name: string,
  credential: unknown,
): Promise<{ error?: string }> {
  const parsed = RegistrationCredential.safeParse(credential);
  if (!parsed.success || name.trim() === "")
    return { error: "That passkey response wasn't valid. Try again." };
  const res = await apiSend(
    "POST",
    "/account/passkeys",
    { name: name.trim().slice(0, 60), credential: parsed.data },
    PasskeyView,
    await apiAuth(),
  );
  if (!res.ok) {
    return {
      error:
        res.error === "challenge_expired"
          ? "That took too long. Enter a new code and try again."
          : "The passkey couldn't be verified. Try again.",
    };
  }
  await setFlash(`Passkey "${res.data.name}" added`);
  revalidatePath("/account");
  return {};
}

export async function removePasskeyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const passkeyId = RecordId.safeParse(field(form, "passkeyId"));
  if (!passkeyId.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/account/passkeys/${passkeyId.data}/remove`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Passkey removed");
  revalidatePath("/account");
  return {};
}
