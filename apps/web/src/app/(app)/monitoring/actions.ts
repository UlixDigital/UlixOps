"use server";
// Monitoring (A148, A149): check one site's certificates and domain, or its uptime, now; set a
// domain's expiry by hand when its registry publishes none; pause or resume a site's uptime
// monitoring. The API checks the role and audits each.
import { Ok, PublicHostname, RecordId, SetDomainExpiry, SetUptimeEnabled } from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const PAGE = "/monitoring/ssl";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function checkSiteExpiryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  if (!site.success) return { error: errorMessage("not_found") };
  const res = await apiSend("POST", `/sites/${site.data}/expiry-check`, {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Checking the certificate and domain. It takes a few seconds.");
  revalidatePath(PAGE);
  revalidatePath(`/sites/${site.data}/monitoring`);
  return {};
}

export async function setDomainExpiryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const domain = PublicHostname.safeParse(text(form, "domain"));
  const raw = text(form, "expiresAt");
  const body = SetDomainExpiry.safeParse({ expiresAt: raw === "" ? null : raw });
  if (!domain.success) return { error: errorMessage("not_found") };
  if (!body.success) return { error: "Enter the date as shown at the registrar (YYYY-MM-DD)." };
  const res = await apiSend(
    "PUT",
    `/monitoring/domains/${domain.data}/expiry`,
    body.data,
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    body.data.expiresAt
      ? `Saved: ${domain.data} expires ${body.data.expiresAt}. Alerts start 30 days before.`
      : `Cleared the date for ${domain.data}.`,
  );
  revalidatePath(PAGE);
  const siteId = RecordId.safeParse(text(form, "siteId"));
  if (siteId.success) revalidatePath(`/sites/${siteId.data}/monitoring`);
  return {};
}

const UPTIME_PAGE = "/monitoring/uptime";

export async function checkSiteUptimeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  if (!site.success) return { error: errorMessage("not_found") };
  const res = await apiSend("POST", `/sites/${site.data}/uptime-check`, {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Checking the site now. It takes a few seconds.");
  revalidatePath(UPTIME_PAGE);
  revalidatePath(`/sites/${site.data}/monitoring`);
  return {};
}

export async function setUptimeEnabledAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const site = RecordId.safeParse(text(form, "siteId"));
  const body = SetUptimeEnabled.safeParse({ enabled: text(form, "enabled") === "true" });
  if (!site.success || !body.success) return { error: errorMessage("not_found") };
  const res = await apiSend("PUT", `/sites/${site.data}/uptime`, body.data, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    body.data.enabled
      ? "Uptime monitoring resumed. The next check runs within 5 minutes."
      : "Uptime monitoring paused for this site. No down alerts until you resume it.",
  );
  revalidatePath(UPTIME_PAGE);
  revalidatePath(`/sites/${site.data}/monitoring`);
  return {};
}
