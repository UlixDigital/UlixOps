"use server";
import { MarkSeenRequest, RecordId, ResolveAlertRequest } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/messages";

const Ok = z.object({ ok: z.literal(true) });

export async function markReadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = RecordId.safeParse(String(form.get("id") ?? ""));
  if (!id.success) return { error: "That notification was not found." };
  const res = await apiSend("POST", `/notifications/${id.data}/read`, {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/notifications");
  revalidatePath("/");
  return {};
}

export async function markAllReadAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const res = await apiSend("POST", "/notifications/read-all", {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/notifications");
  revalidatePath("/");
  return {};
}

/** The user opened the bell, a popup or the page: these notifications were seen (A158). */
export async function markSeenAction(ids: string[]): Promise<void> {
  const body = MarkSeenRequest.safeParse({ ids: ids.slice(0, 100) });
  if (!body.success) return;
  await apiSend("POST", "/notifications/seen", body.data, Ok, await apiAuth());
}

/** "I'm on it": the user takes the alert. */
export async function acknowledgeAlertAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = RecordId.safeParse(String(form.get("alertId") ?? ""));
  if (!id.success) return { error: "That alert was not found." };
  const res = await apiSend(
    "POST",
    `/notifications/alerts/${id.data}/acknowledge`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/notifications");
  revalidatePath("/follow-up");
  return {};
}

/** Reports the fix (or a false alarm) with what was done. */
export async function resolveAlertAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = RecordId.safeParse(String(form.get("alertId") ?? ""));
  if (!id.success) return { error: "That alert was not found." };
  const body = ResolveAlertRequest.safeParse({
    resolution: form.get("resolution"),
    fixAction: form.get("fixAction"),
    note: String(form.get("note") ?? ""),
  });
  if (!body.success)
    return { error: "Choose what you did and describe it in at least 10 characters." };
  const res = await apiSend(
    "POST",
    `/notifications/alerts/${id.data}/resolve`,
    body.data,
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/notifications");
  revalidatePath("/follow-up");
  return {};
}
