// Contracts for the site registry, vault credentials and approvals (Build Order step 5).
import { z } from "zod";
import { PluginName, WpPath } from "./commands";
import {
  CredentialRef,
  HostKeyFingerprint,
  InventoryItem,
  MAX_INVENTORY_ITEMS,
  SshHost,
  TestStep,
} from "./queue";
import { BACKUP_KEY_REF } from "./backups";
import { UptimeSummary } from "./monitoring";
import { API_KEY_NAMES, VulnSummary } from "./vulnerabilities";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

export const HostKind = z.enum(["WPENGINE", "OTHER"]);
export const EnvKind = z.enum(["PRODUCTION", "STAGING"]);
export type EnvKind = z.infer<typeof EnvKind>;
export const SiteTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 _-]{0,39}$/);

export const EnvironmentInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(300),
  sshHost: SshHost,
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  wpPath: WpPath,
  credentialRef: CredentialRef,
});
export type EnvironmentInput = z.infer<typeof EnvironmentInput>;

export const CreateSiteRequest = z.object({
  name: z.string().trim().min(1).max(100),
  host: HostKind,
  tags: z.array(SiteTag).max(10),
  production: EnvironmentInput,
  staging: EnvironmentInput.nullable(),
});

/** Anything may change at once; a new SSH key (credentialRef) needs a second Admin's approval. */
export const UpdateSiteRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  host: HostKind.optional(),
  tags: z.array(SiteTag).max(10).optional(),
  production: EnvironmentInput.optional(),
  staging: EnvironmentInput.nullable().optional(),
});

/**
 * Optional dedicated SFTP for the Files tab (A180/A182). WP Engine SSH gateway has no real SFTP
 * subsystem (slow ShellFs); FileZilla-style `*.sftp.wpengine.com:2222` is fast. Auth may be an
 * SSH vault key or an SFTP password (sealed to the vault; never returned).
 */
const FilesSftpBase = z.object({
  host: SshHost,
  port: z.number().int().min(1).max(65535).default(2222),
  user: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  path: WpPath,
});

export const FilesSftpConnection = z.discriminatedUnion("authKind", [
  FilesSftpBase.extend({
    authKind: z.literal("key"),
    credentialRef: CredentialRef,
  }),
  FilesSftpBase.extend({
    authKind: z.literal("password"),
    /** Required when first enabling password auth or rotating; omit to keep the stored password. */
    password: z.string().min(1).max(128).optional(),
  }),
]);
export type FilesSftpConnection = z.infer<typeof FilesSftpConnection>;

export const FilesSftpConnectionView = z.object({
  enabled: z.boolean(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  user: z.string().nullable(),
  path: z.string().nullable(),
  authKind: z.enum(["key", "password"]),
  credentialRef: z.string().nullable(),
  /** True when a password is stored in the vault (value never returned). */
  passwordSet: z.boolean(),
  hostKeyPinned: z.boolean(),
});
export type FilesSftpConnectionView = z.infer<typeof FilesSftpConnectionView>;

/** PUT body: null clears the dedicated SFTP settings. */
export const FilesSftpConnectionUpdate = z.union([FilesSftpConnection, z.null()]);
export type FilesSftpConnectionUpdate = z.infer<typeof FilesSftpConnectionUpdate>;

/** Stable vault name for an environment's Files SFTP password (A182). */
export function filesSftpPasswordRefFor(environmentId: string): string {
  const id = environmentId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 40);
  return `FILES_SFTP_${id}`;
}

export const EnvironmentView = EnvironmentInput.extend({
  kind: EnvKind,
  hostKey: HostKeyFingerprint.nullable(),
  lastTestAt: iso.nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestError: z.string().nullable(),
  wpVersion: z.string().nullable(),
  phpVersion: z.string().nullable(),
  wpCliVersion: z.string().nullable(),
  /** Last health check (step 9); null until the first one. */
  lastHealthAt: iso.nullable(),
  lastHealthOk: z.boolean().nullable(),
  lastHealthSummary: z.string().nullable(),
  /** Summary of the last inventory refresh (step 6); null until the first one. */
  inventory: z
    .object({
      refreshedAt: iso,
      activeTheme: z.string().nullable(),
      plugins: z.number().int(),
      pluginUpdates: z.number().int(),
      themeUpdates: z.number().int(),
      maintenance: z.boolean().nullable(),
      safeMode: z.boolean(),
      coreUpdateVersion: z.string().nullable().optional(),
      updatesCheckedAt: iso.nullable().optional(),
    })
    .nullable(),
  /** Open vulnerability findings (Phase 2 step 2); absent from older API builds. */
  vulnerabilities: VulnSummary.optional(),
  /** Uptime monitoring (Phase 3 step 2, production only); absent from older API builds. */
  uptime: UptimeSummary.optional(),
  /** Dedicated SFTP for Files (A180); absent from older API builds. */
  filesSftp: FilesSftpConnectionView.optional(),
});
export type EnvironmentView = z.infer<typeof EnvironmentView>;

export const SiteView = z.object({
  id,
  name: z.string(),
  url: z.string(),
  host: HostKind,
  tags: z.array(z.string()),
  archived: z.boolean(),
  createdAt: iso,
  environments: z.array(EnvironmentView),
  pendingApprovals: z.number().int(),
});
export type SiteView = z.infer<typeof SiteView>;
export const SiteList = z.object({ sites: z.array(SiteView) });

export const UpdateSiteResponse = z.object({
  site: SiteView,
  /** Changes waiting for another Admin (e.g. a new SSH key). */
  approvalsRequested: z.array(z.string()),
});

export const TestConnectionResponse = z.object({
  ok: z.boolean(),
  steps: z.array(TestStep),
  hostKey: HostKeyFingerprint.nullable(),
  hostKeyPinned: z.boolean(),
  hostKeyMismatch: z.boolean(),
  wpVersion: z.string().nullable(),
  phpVersion: z.string().nullable(),
  wpCliVersion: z.string().nullable(),
  /** Set when path fallback found WordPress at a different path (A107). */
  wpPath: WpPath.nullable().optional(),
  durationMs: z.number(),
});
export type TestConnectionResponse = z.infer<typeof TestConnectionResponse>;

// ---- Inventory, single-site actions and job logs (Build Order step 6) ---------------------

export const InventoryView = z.object({
  kind: EnvKind,
  refreshedAt: iso,
  refreshedBy: z.object({ id, email: z.string() }).nullable(),
  wpVersion: z.string(),
  phpVersion: z.string(),
  wpCliVersion: z.string(),
  activeTheme: z.string().nullable(),
  maintenance: z.boolean().nullable(),
  safeMode: z.boolean(),
  warnings: z.array(z.string()),
  plugins: z.array(InventoryItem).max(MAX_INVENTORY_ITEMS),
  themes: z.array(InventoryItem).max(MAX_INVENTORY_ITEMS),
  /** Newest WordPress release offered at the last update check (A135). */
  coreUpdateVersion: z.string().nullable().optional(),
  /** Last real update check; until then "up to date" is unknown (A135). */
  updatesCheckedAt: iso.nullable().optional(),
});
export type InventoryView = z.infer<typeof InventoryView>;
export const InventoryResponse = z.object({ inventory: InventoryView.nullable() });

/** What a user may run on one environment. Each maps to one allowlisted command. */
export const SiteActionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plugin.activate"), plugin: PluginName }),
  z.object({
    action: z.literal("plugin.deactivate"),
    plugin: PluginName,
    /** Skip loading plugins and the theme, for a site a plugin has broken. */
    emergency: z.boolean().default(false),
  }),
  z.object({ action: z.literal("maintenance"), on: z.boolean() }),
  z.object({ action: z.literal("cache.flush") }),
]);
export type SiteActionRequest = z.infer<typeof SiteActionRequest>;
export type SiteActionName = SiteActionRequest["action"];

export const SiteJobStatus = z.enum(["RUNNING", "SUCCEEDED", "FAILED"]);
export const SiteJobView = z.object({
  id,
  kind: EnvKind,
  /** e.g. inventory.refresh, plugin.activate, plugin.deactivate, maintenance, cache.flush */
  action: z.string(),
  /** Short human summary, e.g. "Deactivate akismet (emergency)". */
  summary: z.string(),
  status: SiteJobStatus,
  /** Still RUNNING long after any timeout: the API stopped before it finished. */
  interrupted: z.boolean(),
  exitCode: z.number().int().nullable(),
  /** Redacted command output (runner side) or the failure reason. */
  output: z.string(),
  requestedBy: z.object({ id, email: z.string() }).nullable(),
  startedAt: iso,
  finishedAt: iso.nullable(),
  durationMs: z.number().int().nullable(),
});
export type SiteJobView = z.infer<typeof SiteJobView>;
export const SiteJobList = z.object({ jobs: z.array(SiteJobView) });
export const SiteActionResponse = z.object({
  job: SiteJobView,
  /** The server presented a different host key, so nothing ran (Admins were alerted). */
  hostKeyMismatch: z.boolean(),
});
/** Body for POST …/inventory (A114). */
export const InventoryRefreshRequest = z.object({
  /** false/omitted = fast refresh; true = contact update servers. */
  checkUpdates: z.boolean().optional(),
});
export type InventoryRefreshRequest = z.infer<typeof InventoryRefreshRequest>;

export const InventoryRefreshResponse = SiteActionResponse.extend({
  inventory: InventoryView.nullable(),
});

/** Live maintenance status (WP-CLI and/or leftover `.maintenance` file — A111). */
export const MaintenanceStatusResponse = z.object({
  on: z.boolean(),
  /** How we know: live SSH check, or the last inventory when live check was unavailable. */
  source: z.enum(["live", "inventory"]),
  detail: z.string().max(500),
});
export type MaintenanceStatusResponse = z.infer<typeof MaintenanceStatusResponse>;

export const HealthCheckResponse = SiteActionResponse.extend({
  health: z
    .object({
      ok: z.boolean(),
      checkedAt: iso,
      summary: z.string(),
      durationMs: z.number().int().nullable(),
      urlFailures: z.number().int().nonnegative(),
      errorLogOk: z.boolean().nullable(),
    })
    .nullable(),
});
export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;

/** Remote work older than this without an answer is treated as interrupted, not running. */
export const SITE_JOB_STALE_MS = 3 * 60_000;

// ---- Credentials (vault) -------------------------------------------------------------------

/** Keys older than this are flagged for rotation (spec 5: rotation reminders). */
export const ROTATION_DAYS = 90;

export const CredentialView = z.object({
  name: z.string(),
  createdAt: iso,
  updatedAt: iso,
  ageDays: z.number().int(),
  rotationDue: z.boolean(),
  usedBy: z.array(z.object({ siteId: id, siteName: z.string(), kind: EnvKind })),
});
export type CredentialView = z.infer<typeof CredentialView>;
export const CredentialList = z.object({ credentials: z.array(CredentialView) });
export const CreateCredentialRequest = z.object({ name: CredentialRef });
export const CreateCredentialResponse = z.object({ name: CredentialRef, publicKey: z.string() });

// ---- Integration API keys (A133) -------------------------------------------------------------
// Entered in Settings → Credentials after a second Admin approves; stored only in the vault.

/** Vault names of integration API keys the UI may set. */
export const ApiKeyName = z.enum(API_KEY_NAMES);
export type ApiKeyName = z.infer<typeof ApiKeyName>;

/** How long the requester has to enter the key once approved. */
export const API_KEY_WINDOW_MS = 24 * 60 * 60_000;

/** Token-like keys only: no spaces or quotes, so nothing odd reaches the vault or a header. */
export const ApiKeyValue = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{16,300}$/, "16–300 letters, digits, dots, dashes or underscores");

export const SetApiKeyRequest = z.object({ approvalId: id, value: ApiKeyValue });

/** The backup encryption key: exactly 32 bytes as hex (`openssl rand -hex 32`), A145. */
export const BackupKeyValue = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, "64 hex characters");

/** Value rules per key name. */
export function apiKeyValueFor(name: string) {
  return name === BACKUP_KEY_REF ? BackupKeyValue : ApiKeyValue;
}

export const ApiKeyStatus = z.object({
  name: ApiKeyName,
  /** When the vault value last changed; null if not set (or the vault couldn't be reached). */
  setAt: iso.nullable(),
  vaultReachable: z.boolean(),
  /** The open request to set it, if any: pending, or approved and still usable. */
  request: z
    .object({
      id,
      status: z.enum(["PENDING", "APPROVED"]),
      ownRequest: z.boolean(),
      requestedBy: z.string().nullable(),
      /** Approved requests only: the requester can enter the key until then. */
      usableUntil: iso.nullable(),
    })
    .nullable(),
});
export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>;

// ---- Approvals -----------------------------------------------------------------------------

export const ApprovalBulkItemView = z.object({
  asset: z.enum(["plugin", "theme"]),
  name: z.string(),
  version: z.string(),
  updateVersion: z.string(),
  safety: z.enum(["patch", "minor", "major", "unknown"]),
});
export type ApprovalBulkItemView = z.infer<typeof ApprovalBulkItemView>;

export const ApprovalView = z.object({
  id,
  action: z.string(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  summary: z.string(),
  requestedBy: z.object({ id, email: z.string() }).nullable(),
  decidedBy: z.object({ id, email: z.string() }).nullable(),
  comment: z.string().nullable(),
  createdAt: iso,
  decidedAt: iso.nullable(),
  /** The signed-in Admin made this request, so they can't decide it. */
  ownRequest: z.boolean(),
  /** Populated for site.bulk_update so Approvals can show the same review list (A108). */
  bulkItems: z.array(ApprovalBulkItemView).max(200).optional(),
  siteId: id.nullable().optional(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;
export const ApprovalList = z.object({
  pending: z.array(ApprovalView),
  recent: z.array(ApprovalView),
});
export const DecideApprovalRequest = z.object({ comment: z.string().trim().max(500).optional() });
