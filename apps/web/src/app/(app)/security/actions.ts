"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

/** Starts a Wordfence feed sync; the page polls until it ends (Phase 2 step 2). */
export async function syncVulnerabilitiesAction(
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  const res = await apiSend(
    "POST",
    "/vulnerabilities/sync",
    {},
    z.object({ started: z.literal(true) }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Vulnerability feed sync started. Results appear here when it finishes.");
  revalidatePath("/security");
  return {};
}
