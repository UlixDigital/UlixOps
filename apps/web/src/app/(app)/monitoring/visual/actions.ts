"use server";

import { VisualCheckSettings } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { apiSend } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";

const Ok = z.object({}).passthrough();
const Started = z.object({ checkId: z.string() });

export async function saveVisualSettingsAction(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireSession();
  const parsed = VisualCheckSettings.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid settings" };
  const res = await apiSend(
    "PUT",
    "/visual-checks/settings",
    parsed.data,
    VisualCheckSettings,
    await apiAuth(),
  );
  if (!res.ok) return { ok: false, error: "Could not save settings" };
  revalidatePath("/monitoring/visual");
  return { ok: true };
}

export async function runVisualCheckAction(
  siteId: string,
  kind: "PRODUCTION" | "STAGING",
): Promise<{ ok: true; checkId: string } | { ok: false; error: string }> {
  await requireSession();
  const res = await apiSend(
    "POST",
    `/sites/${siteId}/environments/${kind.toLowerCase()}/visual-check`,
    {},
    Started,
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok) return { ok: false, error: "Visual check could not be started" };
  revalidatePath("/monitoring/visual");
  revalidatePath(`/sites/${siteId}/visual`);
  return { ok: true, checkId: res.data.checkId };
}

void Ok;
