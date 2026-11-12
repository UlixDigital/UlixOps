"use server";
// Full backups (A145): back up now, stop, schedule, per-site switch. The API
// checks the role and audits every change.
import { BackupSchedule, EnvKind, Ok, RecordId } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/backups/full";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function backupNowAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const kind = EnvKind.safeParse(text(form, "kind"));
  if (!site.success || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${site.data}/environments/${kind.data.toLowerCase()}/full-backup`,
    {},
    z.object({ backupId: RecordId, position: z.number().int() }),
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  const ahead = res.data.position - 1;
  await setFlash(
    ahead <= 0
      ? "Backup started: health check first, then the database and all files go to Google Drive."
      : `Backup queued: ${ahead} ahead of it. It starts on its own (one at a time).`,
  );
  revalidatePath(PAGE);
  return {};
}

export async function cancelBackupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = RecordId.safeParse(text(form, "backupId"));
  if (!id.success) return { error: errorMessage("not_found") };
  const res = await apiSend("POST", `/full-backups/${id.data}/cancel`, {}, Ok, await apiAuth(), {
    timeoutMs: 20_000,
  });
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    text(form, "running") === "true"
      ? "Backup stopped. The previous copy on Drive was kept."
      : "Removed from the queue.",
  );
  revalidatePath(PAGE);
  return {};
}

export async function saveBackupScheduleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const parsed = BackupSchedule.safeParse({
    enabled: form.get("enabled") === "on",
    dayOfWeek: Number(text(form, "dayOfWeek")),
    startHourUtc: Number(text(form, "startHourUtc")),
    windowHours: Number(text(form, "windowHours")),
    includeStaging: form.get("includeStaging") === "on",
  });
  if (!parsed.success) return { error: "Check the schedule values and try again." };
  const res = await apiSend(
    "PUT",
    "/full-backups/schedule",
    parsed.data,
    BackupSchedule,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(res.data.enabled ? "Backup schedule saved." : "Weekly backups are off.");
  revalidatePath(PAGE);
  return {};
}

export async function setBackupAutoAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const kind = EnvKind.safeParse(text(form, "kind"));
  if (!site.success || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "PUT",
    `/sites/${site.data}/environments/${kind.data.toLowerCase()}/backup-auto`,
    { enabled: text(form, "enabled") === "true" },
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath(PAGE);
  return {};
}
