"use server";
// Plugin registry uploads (screen 7). The API checks and stores everything. The ZIP itself goes
// through /api/plugins/upload (A141); this action only saves the checked upload with its changelog.
import { CreatePluginVersionResponse } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export async function savePluginVersionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const changelog = String(form.get("changelog") ?? "").trim();
  if (!changelog) return { error: "Describe what changed in this version." };
  if (changelog.length > 5000) return { error: "Keep the changelog under 5,000 characters." };
  const res = await apiSend(
    "POST",
    "/plugins/versions",
    {
      uploadId: String(form.get("uploadId") ?? ""),
      changelog,
      dbChanging: form.get("dbChanging") === "on",
    },
    CreatePluginVersionResponse,
    await apiAuth(),
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(`${res.data.slug} ${res.data.version} added to the registry`);
  revalidatePath("/plugins");
  redirect(`/plugins/${res.data.slug}`);
}
