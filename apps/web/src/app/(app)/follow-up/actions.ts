"use server";
import { RecordId, VerifyAlertRequest } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/messages";

const Ok = z.object({ ok: z.literal(true) });

/** Super Admin: confirm or reject a reported fix, or reopen a closed alert (A158). */
export async function verifyAlertAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = RecordId.safeParse(String(form.get("alertId") ?? ""));
  if (!id.success) return { error: "That alert was not found." };
  const body = VerifyAlertRequest.safeParse({
    outcome: form.get("outcome"),
    note: String(form.get("note") ?? ""),
  });
  if (!body.success) return { error: "Add a short note (at least 3 characters) for the record." };
  const res = await apiSend(
    "POST",
    `/alert-tracking/${id.data}/verify`,
    body.data,
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/follow-up");
  revalidatePath(`/follow-up/${id.data}`);
  revalidatePath("/notifications");
  return {};
}
