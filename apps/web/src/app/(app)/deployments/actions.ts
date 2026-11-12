"use server";
import { CreateDeploymentResponse, DeploymentResponse, RecordId } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export async function createDeploymentAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pluginSlug = String(form.get("pluginSlug") ?? "").trim();
  const version = String(form.get("version") ?? "").trim();
  const siteIds = form.getAll("siteIds").map(String).filter(Boolean);
  if (!pluginSlug || !version) return { error: "Choose a plugin and version." };
  if (siteIds.length === 0) return { error: "Choose at least one site." };
  for (const id of siteIds) {
    if (!RecordId.safeParse(id).success) return { error: "One of the sites is invalid." };
  }
  const batchSize = Number(form.get("batchSize") ?? 2);
  const res = await apiSend(
    "POST",
    "/deployments",
    {
      pluginSlug,
      version,
      siteIds,
      stagingFirst: form.get("stagingFirst") === "on",
      batchSize: Number.isFinite(batchSize) ? batchSize : 2,
      pauseOnFailure: form.get("pauseOnFailure") === "on",
    },
    CreateDeploymentResponse,
    await apiAuth(),
    { timeoutMs: 15_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/deployments");
  if (res.data.deployment.status === "PENDING_APPROVAL") {
    await setFlash("Deployment submitted — waiting for Admin approval");
    redirect(`/deployments/${res.data.deployment.id}`);
  }
  await setFlash(
    res.data.approvalId
      ? "Deployment self-approved and started (the other Admins were notified)"
      : "Deployment started",
  );
  redirect(`/deployments/${res.data.deployment.id}`);
}

async function control(id: string, action: "pause" | "resume" | "cancel"): Promise<ActionState> {
  if (!RecordId.safeParse(id).success) return { error: "That deployment was not found." };
  const res = await apiSend(
    "POST",
    `/deployments/${id}/${action}`,
    {},
    DeploymentResponse,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath(`/deployments/${id}`);
  revalidatePath("/deployments");
  return {};
}

export async function pauseDeploymentAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return control(String(form.get("id") ?? ""), "pause");
}

export async function resumeDeploymentAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return control(String(form.get("id") ?? ""), "resume");
}

export async function cancelDeploymentAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return control(String(form.get("id") ?? ""), "cancel");
}
