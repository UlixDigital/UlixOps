"use server";
// Spec screen 12. The API enforces the rules (Admin, never your own request, still current).
import { Ok, RecordId } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export async function decideApprovalAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = RecordId.safeParse(form.get("requestId"));
  const decision = form.get("decision");
  const comment = String(form.get("comment") ?? "")
    .trim()
    .slice(0, 500);
  if (!id.success || (decision !== "approve" && decision !== "reject")) {
    return { error: errorMessage("bad_request") };
  }
  const res = await apiSend(
    "POST",
    `/approvals/${id.data}/${decision}`,
    comment ? { comment } : {},
    Ok,
    await apiAuth(),
  );
  revalidatePath("/approvals");
  revalidatePath("/sites");
  if (!res.ok) return { error: errorMessage(res.error) };
  const bulk = form.get("bulkUpdate") === "1";
  if (decision === "approve" && bulk) {
    await setFlash(
      "Approved — bulk update started in the background. Watch progress on the site's Plugins page.",
    );
  } else {
    await setFlash(decision === "approve" ? "Approved and applied" : "Rejected");
  }
  return {};
}
