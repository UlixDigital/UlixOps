"use server";
// Cloudflare DNS (A156): refresh, record add / edit / delete, rollback request, cache purge and
// the migration checklist. The API checks the role, validates, snapshots and audits.
import {
  type AuthErrorCode,
  CfId,
  ManagedRecordType,
  MigrationStepKey,
  Ok,
  RecordId,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

const zoneOf = (form: FormData) => CfId.safeParse(text(form, "zoneId"));
const Started = z.object({ started: z.boolean() });

/** Cloudflare's own reason for a refusal is in the domain's change history. */
function failure(error: AuthErrorCode): ActionState {
  return { error: errorMessage(error) };
}

export async function syncAllAction(_prev: ActionState): Promise<ActionState> {
  const res = await apiSend("POST", "/dns/sync", {}, Started, await apiAuth());
  if (!res.ok) return failure(res.error);
  await setFlash(
    res.data.started
      ? "Reading every domain from Cloudflare. The page updates when it's done."
      : "A refresh is already running.",
  );
  revalidatePath("/dns");
  return {};
}

export async function syncZoneAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const zone = zoneOf(form);
  if (!zone.success) return failure("not_found");
  const res = await apiSend(
    "POST",
    `/dns/zones/${zone.data}/sync`,
    {},
    z.object({ ok: z.boolean().nullable(), error: z.string().nullable() }),
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok) return failure(res.error);
  if (res.data.ok === false) return { error: res.data.error ?? "The refresh failed." };
  await setFlash("Records read from Cloudflare.");
  revalidatePath(`/dns/${zone.data}`);
  return {};
}

function recordBody(form: FormData) {
  const type = ManagedRecordType.safeParse(text(form, "type"));
  if (!type.success) return null;
  const ttl = text(form, "ttl");
  const priority = text(form, "priority");
  return {
    type: type.data,
    name: text(form, "name") || "@",
    content: text(form, "content"),
    ttl: ttl === "" || ttl === "auto" ? 1 : Number(ttl),
    proxied: form.get("proxied") === "on",
    priority: type.data === "MX" ? (priority === "" ? null : Number(priority)) : null,
    comment: text(form, "comment") || null,
  };
}

const Detail = z.object({ ok: z.literal(true) });

export async function saveRecordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const zone = zoneOf(form);
  const body = recordBody(form);
  if (!zone.success || !body) return failure("bad_request");
  const recordId = text(form, "recordId");
  const editing = recordId !== "";
  if (editing && !CfId.safeParse(recordId).success) return failure("not_found");
  const res = await apiSend(
    editing ? "PUT" : "POST",
    `/dns/zones/${zone.data}/records${editing ? `/${recordId}` : ""}`,
    body,
    Detail,
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok)
    return res.error === "bad_request"
      ? {
          error:
            "Check the values: A needs an IPv4 address, AAAA an IPv6 address, CNAME and MX a host name (MX also a priority), TXT plain text on one line. Only A, AAAA and CNAME can be proxied. TTL is auto or 60–86400.",
        }
      : failure(res.error);
  await setFlash(
    editing
      ? "Record saved. A snapshot was taken first."
      : "Record added. A snapshot was taken first.",
  );
  revalidatePath(`/dns/${zone.data}`);
  // Editing happens in a panel opened by ?edit=; close it once saved.
  if (editing) redirect(`/dns/${zone.data}`);
  return {};
}

export async function deleteRecordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const zone = zoneOf(form);
  const record = CfId.safeParse(text(form, "recordId"));
  if (!zone.success || !record.success) return failure("not_found");
  const res = await apiSend(
    "DELETE",
    `/dns/zones/${zone.data}/records/${record.data}`,
    {},
    Detail,
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok) return failure(res.error);
  await setFlash("Record deleted. The snapshot taken first can bring it back.");
  revalidatePath(`/dns/${zone.data}`);
  return {};
}

export async function requestRollbackAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const zone = zoneOf(form);
  const snapshot = RecordId.safeParse(text(form, "snapshotId"));
  if (!zone.success || !snapshot.success) return failure("not_found");
  const res = await apiSend(
    "POST",
    `/dns/zones/${zone.data}/rollback`,
    { snapshotId: snapshot.data },
    z.object({ rollbackId: RecordId, selfApproved: z.boolean() }),
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok) return failure(res.error);
  await setFlash(
    res.data.selfApproved
      ? "Rollback approved (Super Admin) and running; the other Admins were told. Refresh in a moment."
      : "Rollback requested. Another Admin must approve it on the Approvals page.",
  );
  revalidatePath(`/dns/${zone.data}`);
  return {};
}

export async function purgeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const zone = zoneOf(form);
  if (!zone.success) return failure("not_found");
  const everything = text(form, "everything") === "true";
  const urls = text(form, "urls")
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean);
  if (!everything && urls.length === 0) return { error: "Enter at least one URL, one per line." };
  const res = await apiSend(
    "POST",
    `/dns/zones/${zone.data}/purge`,
    everything ? { everything: true } : { everything: false, urls },
    Ok,
    await apiAuth(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok)
    return res.error === "bad_request"
      ? { error: "Enter up to 30 full URLs (https://…), one per line." }
      : failure(res.error);
  await setFlash(
    everything ? "Cloudflare's cache for this domain was purged." : "Those URLs were purged.",
  );
  revalidatePath(`/dns/${zone.data}`);
  return {};
}

export async function checklistAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const zone = zoneOf(form);
  const key = MigrationStepKey.safeParse(text(form, "key"));
  if (!zone.success || !key.success) return failure("not_found");
  const res = await apiSend(
    "PUT",
    `/dns/zones/${zone.data}/checklist`,
    { key: key.data, done: text(form, "done") === "true" },
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return failure(res.error);
  revalidatePath(`/dns/${zone.data}`);
  return {};
}
