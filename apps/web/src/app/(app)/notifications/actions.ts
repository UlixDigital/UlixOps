"use server";
import { RecordId } from "@ulixops/shared";
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
