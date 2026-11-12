"use server";
// Start "Sign in with Google" (A146): the API asks the runner for Google's consent URL.
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";

export async function signInWithGoogleAction(): Promise<ActionState> {
  const res = await apiSend(
    "POST",
    "/full-backups/drive/authorize",
    {},
    z.object({ authUrl: z.url({ protocol: /^https$/ }) }),
    await apiAuth(),
    { timeoutMs: 35_000 },
  );
  if (!res.ok)
    return {
      error: "Google sign-in couldn't start. Check the client ID and secret below, then try again.",
    };
  if (!res.data.authUrl.startsWith("https://accounts.google.com/"))
    return { error: "Unexpected sign-in address." };
  redirect(res.data.authUrl);
}
