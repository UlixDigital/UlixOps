"use server";
// Integration API keys (A133). The value goes straight to the API in the request body; it is
// never returned, logged, put in a flash message, or rendered back into the page.
import { ApiKeyName, ApiKeyValue, RecordId } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/settings/credentials";

function keyName(form: FormData): string | null {
  const parsed = ApiKeyName.safeParse(form.get("name"));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export async function requestApiKeyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = keyName(form);
  if (!name) return { error: "Unknown key." };
  const res = await apiSend(
    "POST",
    `/credentials/api-keys/${name}/request`,
    {},
    z.object({ id: RecordId, selfApproved: z.boolean().optional() }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    res.data.selfApproved
      ? "Self-approved (the other Admins were notified). Paste the key below."
      : "Request sent. Another Admin must approve it on the Approvals page.",
  );
  revalidatePath(PAGE);
  return {};
}

export async function saveApiKeyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const name = keyName(form);
  const approvalId = RecordId.safeParse(form.get("approvalId"));
  if (!name || !approvalId.success) return { error: "This form is out of date. Refresh the page." };
  const value = ApiKeyValue.safeParse(form.get("value"));
  if (!value.success) return { error: errorMessage("invalid_key") };
  const res = await apiSend(
    "PUT",
    `/credentials/api-keys/${name}`,
    { approvalId: approvalId.data, value: value.data },
    z.object({ setAt: z.iso.datetime() }),
    await apiAuth(),
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Key saved in the vault. The vulnerability feed sync starts now.");
  revalidatePath(PAGE);
  revalidatePath("/security");
  return {};
}
