"use server";
// Site registry. Fields are checked here against the shared schemas so errors can name the
// field; the API checks everything again (role, approvals) before anything changes.
import {
  EnvironmentInput,
  EnvKind,
  HostKind,
  InventoryRefreshResponse,
  Ok,
  HealthCheckResponse,
  BulkUpdateResponse,
  MaintenanceStatusResponse,
  PluginName,
  PluginUpdateResponse,
  RecordId,
  ThemeName,
  ThemeUpdateResponse,
  installFromWpEngineUrl,
  resolveWpEngineEnv,
  WpEngineInstall,
  SiteActionRequest,
  SiteActionResponse,
  type SiteJobView,
  SiteTag,
  SiteView,
  SnapshotActionResponse,
  type TestConnectionResponse,
  TestConnectionResponse as TestConnectionSchema,
  UpdateSiteResponse,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { apiGet, apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

const FIELD_LABELS: Record<string, string> = {
  url: "URL",
  sshHost: "SSH host",
  sshPort: "SSH port",
  sshUser: "SSH user",
  wpPath: "WordPress path",
  credentialRef: "SSH key",
};

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function siteId(form: FormData): string | null {
  const id = RecordId.safeParse(field(form, "siteId"));
  return id.success ? id.data : null;
}

function credentialFor(form: FormData, prefix: string): string {
  return field(form, `${prefix}credentialRef`) || field(form, "sharedCredentialRef");
}

/** Manual SSH fields (Host = Other). */
function otherEnvironment(
  form: FormData,
  prefix: string,
  label: string,
): { ok: true; data: EnvironmentInput } | { ok: false; error: string } {
  const parsed = EnvironmentInput.safeParse({
    url: field(form, `${prefix}url`),
    sshHost: field(form, `${prefix}sshHost`),
    sshPort: Number(field(form, `${prefix}sshPort`) || "22"),
    sshUser: field(form, `${prefix}sshUser`),
    wpPath: field(form, `${prefix}wpPath`),
    credentialRef: credentialFor(form, prefix),
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const names = [...new Set(parsed.error.issues.map((i) => FIELD_LABELS[String(i.path[0])]))];
  return { ok: false, error: `${label}: check ${names.filter(Boolean).join(", ")}.` };
}

/** WP Engine: derive SSH from URL / install hint (A107). */
function wpEngineEnvironment(
  form: FormData,
  prefix: string,
  label: string,
  role: "production" | "staging",
  peerInstall: string | null,
): { ok: true; data: EnvironmentInput; install: string } | { ok: false; error: string } {
  const resolved = resolveWpEngineEnv({
    url: field(form, `${prefix}url`),
    credentialRef: credentialFor(form, prefix),
    installHint: field(form, `${prefix}installHint`) || null,
    peerInstall,
    role,
  });
  if (!resolved.ok) return { ok: false, error: `${label}: ${resolved.error}` };
  const parsed = EnvironmentInput.safeParse({
    url: resolved.data.url,
    sshHost: resolved.data.sshHost,
    sshPort: resolved.data.sshPort,
    sshUser: resolved.data.sshUser,
    wpPath: resolved.data.wpPath,
    credentialRef: resolved.data.credentialRef,
  });
  if (!parsed.success) return { ok: false, error: `${label}: check URL and SSH key.` };
  return { ok: true, data: parsed.data, install: resolved.data.install };
}

function siteFields(form: FormData) {
  const name = field(form, "name");
  const host = HostKind.safeParse(field(form, "host"));
  const rawTags = field(form, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = rawTags.map((t) => SiteTag.safeParse(t));
  if (!name) return { error: "Enter a name." } as const;
  if (!host.success) return { error: "Choose a host." } as const;
  if (tags.some((t) => !t.success) || tags.length > 10) {
    return {
      error: "Tags: up to 10, each starting with a letter or digit (letters, digits, - and _).",
    } as const;
  }

  const hasStaging = form.get("staging") === "on";
  let production: EnvironmentInput;
  let staging: EnvironmentInput | null = null;

  if (host.data === "WPENGINE") {
    // Staging install (from URL or hint) helps derive production on a custom domain.
    let peerForProd: string | null = null;
    if (hasStaging) {
      peerForProd = installFromWpEngineUrl(field(form, "stg_url"));
      if (!peerForProd) {
        const hint = WpEngineInstall.safeParse(field(form, "stg_installHint"));
        peerForProd = hint.success ? hint.data : null;
      }
    }
    const prod = wpEngineEnvironment(form, "prod_", "Production", "production", peerForProd);
    if (!prod.ok) return { error: prod.error } as const;
    production = prod.data;
    if (hasStaging) {
      const stg = wpEngineEnvironment(form, "stg_", "Staging", "staging", prod.install);
      if (!stg.ok) return { error: stg.error } as const;
      staging = stg.data;
    }
  } else {
    const prod = otherEnvironment(form, "prod_", "Production");
    if (!prod.ok) return { error: prod.error } as const;
    production = prod.data;
    if (hasStaging) {
      const stg = otherEnvironment(form, "stg_", "Staging");
      if (!stg.ok) return { error: stg.error } as const;
      staging = stg.data;
    }
  }

  return {
    data: {
      name,
      host: host.data,
      tags: [...new Set(tags.flatMap((t) => (t.success ? [t.data] : [])))],
      production,
      staging,
    },
  } as const;
}

export async function createSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const fields = siteFields(form);
  if (!fields.data) return { error: fields.error };
  const res = await apiSend("POST", "/sites", fields.data, SiteView, await apiAuth());
  if (!res.ok) return { error: errorMessage(res.error) };
  // Don't await Test connection here: the web→API fetch default is 5s and SSH tests need ~70s,
  // which crashed the add-site page. Overview runs tests via ?autotest=1 (A107).
  await setFlash(`${res.data.name} added. Testing connection on the next screen…`);
  revalidatePath("/sites");
  revalidatePath(`/sites/${res.data.id}`);
  redirect(`/sites/${res.data.id}?autotest=1`);
}

export async function updateSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const fields = siteFields(form);
  if (!id) return { error: errorMessage("not_found") };
  if (!fields.data) return { error: fields.error };
  const res = await apiSend(
    "PATCH",
    `/sites/${id}`,
    fields.data,
    UpdateSiteResponse,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  const waiting = res.data.approvalsRequested;
  await setFlash(
    waiting.length > 0 ? `Saved. Waiting for another Admin: ${waiting.join(", ")}` : "Saved",
  );
  revalidatePath(`/sites/${id}`);
  redirect(`/sites/${id}`);
}

export async function setArchivedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  if (!id) return { error: errorMessage("not_found") };
  const archive = field(form, "archive") === "true";
  const res = await apiSend(
    "POST",
    `/sites/${id}/${archive ? "archive" : "restore"}`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash(
    archive ? "Archive requested — another Admin must approve it on Approvals." : "Site restored",
  );
  revalidatePath("/sites");
  revalidatePath(`/sites/${id}`);
  revalidatePath("/approvals");
  return {};
}

export interface TestState {
  error?: string;
  result?: TestConnectionResponse;
}

export async function testConnectionAction(_prev: TestState, form: FormData): Promise<TestState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/test`,
    {},
    TestConnectionSchema,
    await apiAuth(),
    // The API waits up to 60 s for the runner.
    { timeoutMs: 70_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath(`/sites/${id}`);
  return { result: res.data };
}

export async function resetHostKeyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/host-key/reset`,
    {},
    Ok,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Requested. Another Admin must approve it on the Approvals page.");
  revalidatePath(`/sites/${id}`);
  return {};
}

/** Toast for a finished job, or an inline error that points at the job log. */
async function reportJob(id: string, job: SiteJobView, hostKeyMismatch: boolean) {
  revalidatePath(`/sites/${id}`, "layout");
  if (job.status === "SUCCEEDED") {
    await setFlash(`Done: ${job.summary}`);
    return {};
  }
  if (hostKeyMismatch) {
    return {
      error:
        "Refused: the server's SSH host key changed, so nothing ran. Admins were alerted. Check with the host before resetting the key.",
    };
  }
  const reason = job.output.split("\n").find((line) => line.trim()) ?? "no output";
  return { error: `Failed: ${job.summary}. ${reason.slice(0, 300)} (full output under Logs)` };
}

/**
 * Reads versions, plugins and themes over WP-CLI.
 * Default is a fast refresh (no update probes). Pass checkUpdates=true for Check for updates (A114).
 */
export async function refreshInventoryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const checkUpdates = field(form, "checkUpdates") === "true";
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/inventory`,
    { checkUpdates },
    InventoryRefreshResponse,
    await apiAuth(),
    // API waits up to 180 s; web budget is a little higher (A114).
    { timeoutMs: 200_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** Live maintenance check for Emergency (client-side after paint — A113). */
export async function checkMaintenanceLiveAction(
  siteIdRaw: string,
  kindRaw: string,
): Promise<
  { ok: true; on: boolean; source: "live" | "inventory"; detail: string } | { ok: false }
> {
  const id = RecordId.safeParse(siteIdRaw);
  const kind = EnvKind.safeParse(kindRaw);
  if (!id.success || !kind.success) return { ok: false };
  const res = await apiGet(
    `/sites/${id.data}/environments/${kind.data.toLowerCase()}/maintenance`,
    MaintenanceStatusResponse,
    await apiAuth(),
    // Keep short so a hung SSH session cannot freeze the Emergency UI.
    { timeoutMs: 20_000 },
  );
  if (!res.ok) return { ok: false };
  return { ok: true, on: res.data.on, source: res.data.source, detail: res.data.detail };
}

/** Plugin activate / deactivate, maintenance mode and cache flush on one environment. */
export async function siteActionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const action = SiteActionRequest.safeParse({
    action: field(form, "action"),
    ...(form.has("plugin") ? { plugin: field(form, "plugin") } : {}),
    ...(form.has("on") ? { on: field(form, "on") === "true" } : {}),
    ...(form.has("emergency") ? { emergency: field(form, "emergency") === "true" } : {}),
  });
  if (!action.success) {
    return form.has("plugin")
      ? {
          error:
            "Enter the plugin's folder name as WP-CLI shows it (letters, digits, -, _ and .), e.g. akismet.",
        }
      : { error: errorMessage("bad_request") };
  }
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/actions`,
    action.data,
    SiteActionResponse,
    await apiAuth(),
    // The API waits up to 45 s for the runner.
    { timeoutMs: 55_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** Quick snapshot of one plugin folder (and optional DB). */
export async function createSnapshotAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  const plugin = PluginName.safeParse(field(form, "plugin"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  if (!plugin.success) {
    return {
      error:
        "Enter the plugin's folder name as WP-CLI shows it (letters, digits, -, _ and .), e.g. akismet.",
    };
  }
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/snapshots`,
    { plugin: plugin.data, includeDb: field(form, "includeDb") === "true" },
    SnapshotActionResponse,
    await apiAuth(),
    { timeoutMs: 200_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

export async function restoreSnapshotAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  const backupId = RecordId.safeParse(field(form, "backupId"));
  if (!id || !kind.success || !backupId.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/snapshots/${backupId.data}/restore`,
    {},
    SnapshotActionResponse,
    await apiAuth(),
    { timeoutMs: 200_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

export async function rollbackLastAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/rollback`,
    {},
    SnapshotActionResponse,
    await apiAuth(),
    { timeoutMs: 200_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** HTTP (+ optional debug.log) health check for one environment (Build Order step 9). */
export async function runHealthCheckAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/health`,
    {},
    HealthCheckResponse,
    await apiAuth(),
    { timeoutMs: 100_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath(`/sites/${id}`, "layout");
  revalidatePath("/sites");
  if (res.data.hostKeyMismatch) {
    return {
      error:
        "Refused: the server's SSH host key changed, so nothing ran. Admins were alerted. Check with the host before resetting the key.",
    };
  }
  if (res.data.health?.ok) {
    await setFlash(`Healthy: ${res.data.health.summary}`);
    return {};
  }
  if (res.data.health) {
    return { error: `Unhealthy: ${res.data.health.summary}` };
  }
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** Snapshot first, then WP-CLI plugin update (Build Order step 8). */
export async function updatePluginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  const plugin = PluginName.safeParse(field(form, "plugin"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  if (!plugin.success) {
    return {
      error:
        "Enter the plugin's folder name as WP-CLI shows it (letters, digits, -, _ and .), e.g. akismet.",
    };
  }
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/plugins/update`,
    {
      plugin: plugin.data,
      ...(form.has("includeDb") ? { includeDb: field(form, "includeDb") === "true" } : {}),
    },
    PluginUpdateResponse,
    await apiAuth(),
    { timeoutMs: 320_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  revalidatePath(`/sites/${id}/plugins`);
  if (res.data.updateJob) {
    return reportJob(id, res.data.updateJob, res.data.hostKeyMismatch);
  }
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** Snapshot first, then WP-CLI theme update (A104). */
export async function updateThemeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  const theme = ThemeName.safeParse(field(form, "theme"));
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  if (!theme.success) {
    return {
      error:
        "Enter the theme's folder name as WP-CLI shows it (letters, digits, -, _ and .), e.g. twentytwentyfive.",
    };
  }
  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/themes/update`,
    {
      theme: theme.data,
      ...(form.has("includeDb") ? { includeDb: field(form, "includeDb") === "true" } : {}),
    },
    ThemeUpdateResponse,
    await apiAuth(),
    { timeoutMs: 320_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  revalidatePath(`/sites/${id}/plugins`);
  if (res.data.updateJob) {
    return reportJob(id, res.data.updateJob, res.data.hostKeyMismatch);
  }
  return reportJob(id, res.data.job, res.data.hostKeyMismatch);
}

/** Snapshot each outdated plugin/theme, update, then refresh inventory (A104 / A108). */
export async function bulkUpdateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = siteId(form);
  const kind = EnvKind.safeParse(field(form, "kind"));
  const strategy = field(form, "strategy") || "snapshots";
  if (!id || !kind.success) return { error: errorMessage("not_found") };
  if (strategy !== "snapshots" && strategy !== "google_drive") {
    return { error: errorMessage("bad_request") };
  }
  const envPath = kind.data === "STAGING" ? "staging" : "production";
  const pluginsPath = `/sites/${id}/plugins?env=${envPath}`;

  let items: unknown = undefined;
  const rawItems = field(form, "items");
  if (rawItems) {
    try {
      items = JSON.parse(rawItems);
    } catch {
      return { error: errorMessage("bad_request") };
    }
  }

  const res = await apiSend(
    "POST",
    `/sites/${id}/environments/${kind.data.toLowerCase()}/bulk-update`,
    { strategy, ...(items !== undefined ? { items } : {}) },
    BulkUpdateResponse,
    await apiAuth(),
    // Approval path returns quickly; immediate runs can take a long time (A108).
    { timeoutMs: 900_000 },
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  revalidatePath("/backups");
  revalidatePath(`/sites/${id}/plugins`);
  revalidatePath("/approvals");
  if (res.data.status === "pending_approval") {
    await setFlash(
      "Bulk update submitted — waiting for another Admin on Approvals. You will be notified when it finishes.",
    );
    redirect(pluginsPath);
  }
  if (res.data.status === "rejected_strategy") {
    return { error: errorMessage("google_drive_unavailable") };
  }
  const failed = res.data.results.filter(
    (r) => r.status === "failed" || r.status === "rolled_back",
  );
  const ok = res.data.results.filter((r) => r.status === "succeeded").length;
  if (failed.length === 0) {
    await setFlash(
      `Updated ${ok} item${ok === 1 ? "" : "s"}${res.data.inventoryRefreshed ? "; inventory refreshed" : ""}.`,
    );
    redirect(pluginsPath);
  }
  return {
    error: `${ok} succeeded, ${failed.length} failed: ${failed.map((f) => f.name).join(", ")}. ${failed[0]?.detail ?? ""}`,
  };
}
