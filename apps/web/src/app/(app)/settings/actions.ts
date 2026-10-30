"use server";
// Users & roles and settings. Each call is checked again by the API (role, self-protection,
// lockout protection); these only turn form fields into requests and show the result.
import {
  CreateCredentialResponse,
  CredentialRef,
  InviteUserResponse,
  IpAllowlistSetting,
  Ok,
  RecordId,
  Role,
  SetupLinkResponse,
  UserDetail,
} from "@ulixops/shared";
import { isValidCidr } from "@ulixops/shared/ip";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const ROLE_LABELS = { ADMIN: "Admin", DEVELOPER: "Developer", VIEWER: "Viewer" } as const;
const UserResponse = z.object({ user: UserDetail.shape.user });

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function userId(form: FormData): string | null {
  const id = RecordId.safeParse(field(form, "userId"));
  return id.success ? id.data : null;
}

async function done(message: string, path: string): Promise<ActionState> {
  await setFlash(message);
  revalidatePath(path);
  return {};
}

export async function inviteUserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const role = Role.safeParse(field(form, "role"));
  if (!role.success) return { error: "Choose a role." };
  const res = await apiSend(
    "POST",
    "/users",
    { email: field(form, "email"), name: field(form, "name") || undefined, role: role.data },
    InviteUserResponse,
    await apiAuth(),
  );
  if (!res.ok) {
    return {
      error: res.error === "bad_request" ? "Enter a valid email address." : errorMessage(res.error),
    };
  }
  await setFlash(`Invited ${res.data.user.email} as ${ROLE_LABELS[res.data.user.role]}`);
  revalidatePath("/settings/users");
  return { link: res.data.setupLink };
}

export async function changeRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = userId(form);
  const role = Role.safeParse(field(form, "role"));
  if (!id || !role.success) return { error: "Choose a role." };
  const res = await apiSend(
    "PATCH",
    `/users/${id}`,
    { role: role.data },
    UserResponse,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return done(`Role changed to ${ROLE_LABELS[role.data]}`, `/settings/users/${id}`);
}

export async function setActiveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = userId(form);
  if (!id) return { error: errorMessage("not_found") };
  const active = field(form, "active") === "true";
  const res = await apiSend("PATCH", `/users/${id}`, { active }, UserResponse, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  return done(
    active ? "Access restored" : "Access removed and sessions ended",
    `/settings/users/${id}`,
  );
}

export async function resetTwoFactorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = userId(form);
  if (!id) return { error: errorMessage("not_found") };
  const res = await apiSend("POST", `/users/${id}/reset-2fa`, {}, Ok, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  return done("2FA reset. They'll set it up again at their next sign-in", `/settings/users/${id}`);
}

export async function newSetupLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = userId(form);
  if (!id) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/users/${id}/setup-link`,
    {},
    SetupLinkResponse,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath(`/settings/users/${id}`);
  return { link: res.data.setupLink };
}

export async function revokeUserSessionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = userId(form);
  const sessionId = RecordId.safeParse(field(form, "sessionId"));
  if (!id || !sessionId.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/users/${id}/sessions/${sessionId.data}/revoke`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return done("Session ended", `/settings/users/${id}`);
}

/** Entries are one per line: an address or CIDR range, then an optional label. */
export async function saveAllowlistAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const lines = field(form, "entries")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const entries = lines.map((line) => {
    const [cidr = "", ...label] = line.split(/\s+/);
    return { cidr, label: label.join(" ").slice(0, 80) };
  });
  const invalid = entries.filter((entry) => !isValidCidr(entry.cidr)).map((entry) => entry.cidr);
  if (invalid.length > 0)
    return { error: `Not a valid IP address or range: ${invalid.slice(0, 5).join(", ")}` };
  const res = await apiSend(
    "PUT",
    "/settings/ip-allowlist",
    { enabled: form.get("enabled") === "on", entries },
    IpAllowlistSetting,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return done(
    res.data.enabled ? "IP allowlist saved and enforced" : "IP allowlist saved (not enforced)",
    "/settings/ip-allowlist",
  );
}

/** Creates an SSH key in the vault (via the runner) and shows its public half once. */
export async function createCredentialAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  // "client a ssh" → "CLIENT_A_SSH": the vault's naming style, so typing is forgiving.
  const name = CredentialRef.safeParse(
    field(form, "name")
      .toUpperCase()
      .replace(/[\s-]+/g, "_"),
  );
  if (!name.success) {
    return { error: "Use 3–64 characters: letters, digits and _, starting with a letter." };
  }
  const res = await apiSend(
    "POST",
    "/credentials",
    { name: name.data },
    CreateCredentialResponse,
    await apiAuth(),
    { timeoutMs: 50_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(`${res.data.name} created in the vault`);
  revalidatePath("/settings/credentials");
  return { link: res.data.publicKey };
}
