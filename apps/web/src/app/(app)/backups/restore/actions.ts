"use server";
// Restore from Google Drive (A152): ask for a restore, or withdraw one that hasn't started. The
// API checks the role and the typed name, asks a second Admin, and audits every step.
import { Ok, RecordId, StartRestoreRequest } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/backups/restore";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function startRestoreAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const body = StartRestoreRequest.safeParse({
    backupId: text(form, "backupId"),
    scope: text(form, "scope"),
    confirmName: text(form, "confirmName"),
    target: text(form, "target") || undefined,
  });
  if (!body.success) return { error: "Pick a backup, what to restore, and type the site's name." };
  const res = await apiSend(
    "POST",
    "/full-backups/restores",
    body.data,
    z.object({ restoreId: RecordId, selfApproved: z.boolean() }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    res.data.selfApproved
      ? "Restore approved (Super Admin) and queued. It starts within a few minutes with a safety copy of the site; the other Admins were told."
      : "Restore requested. Another Admin must approve it on the Approvals page; it starts after that.",
  );
  revalidatePath(PAGE);
  return {};
}

export async function cancelRestoreAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = RecordId.safeParse(text(form, "restoreId"));
  if (!id.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/full-backups/restores/${id.data}/cancel`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Restore cancelled. Nothing on the site was changed.");
  revalidatePath(PAGE);
  return {};
}
