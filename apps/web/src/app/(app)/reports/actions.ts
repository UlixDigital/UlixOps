"use server";

import { GenerateReportRequest, SiteReportView } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { apiSend } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";

const EmailOk = z.object({ ok: z.literal(true), to: z.array(z.string()) });
const SiteId = z.string().regex(/^[a-z0-9]{1,64}$/);

export async function generateReportAction(
  siteId: string,
  periodStart?: string,
): Promise<{ ok: true; report: SiteReportView } | { ok: false; error: string }> {
  await requireSession();
  const id = SiteId.safeParse(siteId);
  if (!id.success) return { ok: false, error: "Invalid site" };
  const body = GenerateReportRequest.parse({
    siteId: id.data,
    ...(periodStart ? { periodStart } : {}),
  });
  const res = await apiSend("POST", "/reports/generate", body, SiteReportView, await apiAuth(), {
    timeoutMs: 120_000,
  });
  if (!res.ok) return { ok: false, error: "Could not generate the report" };
  revalidatePath("/reports");
  return { ok: true, report: res.data };
}

export async function emailReportAction(
  reportId: string,
  extraTo: string[],
): Promise<{ ok: true; to: string[] } | { ok: false; error: string }> {
  await requireSession();
  const res = await apiSend(
    "POST",
    `/reports/${reportId}/email`,
    { to: extraTo },
    EmailOk,
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok) {
    if (res.error === "smtp_not_configured")
      return { ok: false, error: "SMTP is not configured on the hub" };
    return { ok: false, error: "Could not send the report" };
  }
  revalidatePath("/reports");
  revalidatePath(`/reports/${reportId}`);
  return { ok: true, to: res.data.to };
}
