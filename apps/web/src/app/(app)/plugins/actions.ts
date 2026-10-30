"use server";
// Plugin registry uploads (screen 7). The API checks and stores everything; these actions only
// forward the file and the changelog for the signed-in user.
import {
  CreatePluginVersionResponse,
  MAX_PLUGIN_ZIP_BYTES,
  PluginUploadResult,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { apiSend, apiUpload } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export interface CheckState {
  error?: string;
  result?: PluginUploadResult;
}

export async function checkPluginZipAction(_prev: CheckState, form: FormData): Promise<CheckState> {
  const file = form.get("zip");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a plugin ZIP file." };
  if (file.size > MAX_PLUGIN_ZIP_BYTES)
    return { error: `The file is larger than ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024} MB.` };
  const res = await apiUpload(
    `/plugins/uploads?filename=${encodeURIComponent(file.name.slice(0, 200))}`,
    new Uint8Array(await file.arrayBuffer()),
    "application/zip",
    PluginUploadResult,
    await apiAuth(),
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return { result: res.data };
}

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
