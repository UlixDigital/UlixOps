"use server";
// Read a site's PHP error log now (A159). Read-only over SSH; the API checks the role.
import { EnvKind, ErrorLogView, RecordId } from "@ulixops/shared";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function readErrorLogAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const kind = EnvKind.safeParse(text(form, "kind"));
  if (!site.success || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/environments/${kind.data.toLowerCase()}/php-errors`,
    {},
    ErrorLogView,
    await apiAuth(),
    { timeoutMs: 100_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  if (res.data.ok === false) return { error: res.data.detail ?? "The log couldn't be read." };
  await setFlash(
    res.data.fileFound
      ? `Error log read: ${res.data.fatal24h} fatal, ${res.data.warnings24h} warnings in the last 24 hours.`
      : "This site has no PHP error log yet. Switch logging on first.",
  );
  revalidatePath(`/sites/${site.data}/logs`);
  revalidatePath("/monitoring/php-errors");
  return {};
}

const Switched = z.object({ ok: z.boolean(), exposed: z.boolean(), detail: z.string() });

/** Switch PHP error logging on or off for one environment (A160). */
export async function setLoggingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const kind = EnvKind.safeParse(text(form, "kind"));
  if (!site.success || !kind.success) return { error: errorMessage("not_found") };
  const enabled = text(form, "enabled") === "true";
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/environments/${kind.data.toLowerCase()}/debug-log`,
    { enabled },
    Switched,
    await apiAuth(),
    { timeoutMs: 200_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  if (!res.data.ok) return { error: res.data.detail };
  await setFlash(res.data.detail);
  revalidatePath(`/sites/${site.data}/logs`);
  revalidatePath("/monitoring/php-errors");
  return {};
}

/** Ask to switch logging on for every listed environment (a second Admin approves). */
export async function bulkLoggingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ids = z.array(RecordId).min(1).max(200).safeParse(form.getAll("environmentId"));
  if (!ids.success) return { error: "No sites to switch on." };
  const res = await apiSend(
    "POST",
    "/monitoring/php-errors/logging-bulk",
    { environmentIds: ids.data },
    z.object({ requestId: RecordId, selfApproved: z.boolean(), count: z.number().int() }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    res.data.selfApproved
      ? `Approved (Super Admin): switching logging on for ${res.data.count} sites, one at a time. You'll get an alert with the result.`
      : `Requested for ${res.data.count} sites. Another Admin approves it on the Approvals page; you'll get an alert with the result.`,
  );
  revalidatePath("/monitoring/php-errors");
  return {};
}
