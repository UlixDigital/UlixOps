"use server";
// File integrity (A144): run a check, mark a reviewed change as safe, remove a rule. The API
// checks the role and audits every change.
import { EnvKind, MarkMalwareSafe, Ok, RecordId } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/security/integrity";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function startIntegrityCheckAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const kind = EnvKind.safeParse(text(form, "kind"));
  if (!site.success || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/environments/${kind.data.toLowerCase()}/integrity-check`,
    {},
    z.object({ checkId: RecordId }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    "File integrity check started. It takes a minute or two; the page updates on its own.",
  );
  revalidatePath(PAGE);
  revalidatePath(`/sites/${site.data}/security`);
  return {};
}

export async function markChangeSafeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const finding = RecordId.safeParse(text(form, "findingId"));
  const check = RecordId.safeParse(text(form, "checkId"));
  const body = MarkMalwareSafe.safeParse({ reason: text(form, "reason") });
  if (!finding.success || !check.success) return { error: errorMessage("not_found") };
  if (!body.success) return { error: "Say why this change is expected (at least 3 characters)." };
  const res = await apiSend(
    "POST",
    `/integrity-checks/findings/${finding.data}/safe`,
    body.data,
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    "Marked as an expected change. Later checks of this site won't count or alert on it.",
  );
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/${check.data}`);
  return {};
}

export async function removeChangeRuleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const rule = RecordId.safeParse(text(form, "ruleId"));
  const check = RecordId.safeParse(text(form, "checkId"));
  if (!rule.success || !check.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "DELETE",
    `/integrity-checks/ignores/${rule.data}`,
    null,
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Rule removed. The change counts again.");
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/${check.data}`);
  return {};
}
