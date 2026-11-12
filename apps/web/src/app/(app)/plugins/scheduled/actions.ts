"use server";
// Scheduled updates (A162): window and skip list, switching on (approval) and off, holds.
import {
  AutoUpdateSettingsRequest,
  AutoUpdateView,
  AutoUpdateWindow,
  RecordId,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/plugins/scheduled";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function refresh(siteId?: string) {
  revalidatePath(PAGE);
  if (siteId) revalidatePath(`/sites/${siteId}/plugins`);
}

/** Skip entries arrive as "plugin:akismet" / "theme:astra" checkbox values. */
function skipOf(form: FormData) {
  return form.getAll("skip").flatMap((v) => {
    if (typeof v !== "string") return [];
    const [asset, ...rest] = v.split(":");
    return [{ asset, name: rest.join(":") }];
  });
}

export async function saveAutoUpdateSettingsAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const body = AutoUpdateSettingsRequest.safeParse({
    dayOfWeek: Number(text(form, "dayOfWeek")),
    hourUtc: Number(text(form, "hourUtc")),
    skip: skipOf(form),
  });
  if (!site.success || !body.success) return { error: "Check the window and skip list." };
  const res = await apiSend(
    "PUT",
    `/sites/${site.data}/auto-updates`,
    body.data,
    AutoUpdateView,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Scheduled update settings saved.");
  refresh(site.data);
  return {};
}

const Enabled = z.object({
  requestId: RecordId,
  selfApproved: z.boolean(),
  count: z.number().int(),
});

/** Switching on always waits for another Admin (a Super Admin approves their own). */
export async function enableAutoUpdatesAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ids = z.array(RecordId).min(1).max(200).safeParse(form.getAll("siteId"));
  if (!ids.success) return { error: "Choose at least one site." };
  const day = text(form, "dayOfWeek");
  const window = AutoUpdateWindow.safeParse({
    dayOfWeek: Number(day),
    hourUtc: Number(text(form, "hourUtc")),
  });
  const res = await apiSend(
    "POST",
    "/auto-updates/enable",
    { siteIds: ids.data, ...(day && window.success ? { window: window.data } : {}) },
    Enabled,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  const sites = `${res.data.count} site${res.data.count === 1 ? "" : "s"}`;
  await setFlash(
    res.data.selfApproved
      ? `Approved (Super Admin): scheduled updates are on for ${sites}. The first run is the next window.`
      : `Requested for ${sites}. Another Admin approves it on the Approvals page.`,
  );
  refresh(ids.data.length === 1 ? ids.data[0] : undefined);
  return {};
}

export async function disableAutoUpdatesAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  if (!site.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/auto-updates/disable`,
    {},
    AutoUpdateView,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Scheduled updates are off for this site.");
  refresh(site.data);
  return {};
}

export async function clearHoldAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  if (!site.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/auto-updates/holds/clear`,
    { asset: text(form, "asset"), name: text(form, "name") },
    AutoUpdateView,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Hold cleared: that version will be tried in the next window.");
  refresh(site.data);
  return {};
}
