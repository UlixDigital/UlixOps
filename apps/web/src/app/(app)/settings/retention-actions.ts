"use server";

import { SnapshotRetentionSetting } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export async function saveRetentionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = form.get("days");
  const days = typeof raw === "string" ? Number(raw) : NaN;
  const parsed = SnapshotRetentionSetting.safeParse({ days });
  if (!parsed.success) return { error: "Enter a whole number of days between 1 and 90." };
  const res = await apiSend(
    "PUT",
    "/settings/snapshot-retention",
    parsed.data,
    SnapshotRetentionSetting,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(`Snapshot retention set to ${res.data.days} days.`);
  revalidatePath("/settings");
  return {};
}
